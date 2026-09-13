#ifndef _WIN32
#define _GNU_SOURCE
#endif
#include "platform.h"
#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  lock_handle fd;
  bool cleanup_registered;
} lock_file;
static const napi_type_tag lock_file_tag = {0x47f5d6637bd940f4ULL,
                                            0xa7e80655ef066da3ULL};

#define NAPI(call)                                                             \
  do {                                                                         \
    if ((call) != napi_ok) {                                                   \
      napi_throw_error(env, NULL, "Node-API call failed");                     \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

static napi_value system_error(napi_env env, unsigned long error) {
  const char *code = "EIO";
  char message[256];
#ifdef _WIN32
  switch (error) {
  case ERROR_FILE_NOT_FOUND:
  case ERROR_PATH_NOT_FOUND:
    code = "ENOENT";
    break;
  case ERROR_ACCESS_DENIED:
    code = "EACCES";
    break;
  case ERROR_SHARING_VIOLATION:
  case ERROR_LOCK_VIOLATION:
    code = "EBUSY";
    break;
  case ERROR_FILE_EXISTS:
  case ERROR_ALREADY_EXISTS:
    code = "EEXIST";
    break;
  case ERROR_INVALID_HANDLE:
    code = "EBADF";
    break;
  case ERROR_INVALID_PARAMETER:
  case ERROR_INVALID_NAME:
    code = "EINVAL";
    break;
  case ERROR_TOO_MANY_OPEN_FILES:
    code = "EMFILE";
    break;
  case ERROR_DISK_FULL:
    code = "ENOSPC";
    break;
  case ERROR_FILENAME_EXCED_RANGE:
    code = "ENAMETOOLONG";
    break;
  case ERROR_NOT_ENOUGH_MEMORY:
  case ERROR_OUTOFMEMORY:
    code = "ENOMEM";
    break;
  case ERROR_NOT_SUPPORTED:
    code = "ENOTSUP";
    break;
  }
  snprintf(message, sizeof(message), "%s: Windows error %lu", code, error);
#else
  switch (error) {
  case ENOENT:
    code = "ENOENT";
    break;
  case EACCES:
    code = "EACCES";
    break;
  case EPERM:
    code = "EPERM";
    break;
  case ELOOP:
    code = "ELOOP";
    break;
  case EEXIST:
    code = "EEXIST";
    break;
  case EBADF:
    code = "EBADF";
    break;
  case EINVAL:
    code = "EINVAL";
    break;
  case EISDIR:
    code = "EISDIR";
    break;
  case ENOTDIR:
    code = "ENOTDIR";
    break;
  case EMFILE:
    code = "EMFILE";
    break;
  case ENFILE:
    code = "ENFILE";
    break;
  case ENOSPC:
    code = "ENOSPC";
    break;
  case EROFS:
    code = "EROFS";
    break;
  case ENAMETOOLONG:
    code = "ENAMETOOLONG";
    break;
  case ENOMEM:
    code = "ENOMEM";
    break;
  case ENOLCK:
    code = "ENOLCK";
    break;
  case ENOTSUP:
    code = "ENOTSUP";
    break;
  }
  snprintf(message, sizeof(message), "%s: %s", code, strerror((int)error));
#endif
  napi_throw_error(env, code, message);
  return NULL;
}

static unsigned long close_handle(lock_handle fd) {
#ifdef _WIN32
  return CloseHandle(fd) ? 0 : GetLastError();
#else
  return close(fd) == 0 ? 0 : (unsigned long)errno;
#endif
}

static unsigned long read_stat(lock_handle fd, struct lock_stat *out) {
#ifdef _WIN32
  BY_HANDLE_FILE_INFORMATION st;
  if (!GetFileInformationByHandle(fd, &st))
    return GetLastError();
  out->dev = st.dwVolumeSerialNumber;
  out->ino = ((uint64_t)st.nFileIndexHigh << 32) | st.nFileIndexLow;
  out->nlink = st.nNumberOfLinks;
  out->size = ((uint64_t)st.nFileSizeHigh << 32) | st.nFileSizeLow;
  out->mode = st.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT ? 0120000
              : st.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY   ? 0040000
                                                                 : 0100000;
  out->mode |= st.dwFileAttributes & FILE_ATTRIBUTE_READONLY ? 0444 : 0666;
#else
  struct stat st;
  if (fstat(fd, &st) < 0)
    return (unsigned long)errno;
  out->dev = (uint64_t)st.st_dev;
  out->ino = (uint64_t)st.st_ino;
  out->mode = (uint64_t)st.st_mode;
  out->nlink = (uint64_t)st.st_nlink;
  out->size = (uint64_t)st.st_size;
#endif
  return 0;
}

/* All clients use the same lock family and whole-file range on each OS. */
static unsigned long change_lock(lock_handle fd, bool shared, bool release,
                                 bool *acquired) {
#ifdef _WIN32
  OVERLAPPED data = {0};
  BOOL ok = release ? UnlockFileEx(fd, 0, MAXDWORD, MAXDWORD, &data)
                    : LockFileEx(fd,
                                 LOCKFILE_FAIL_IMMEDIATELY |
                                     (shared ? 0 : LOCKFILE_EXCLUSIVE_LOCK),
                                 0, MAXDWORD, MAXDWORD, &data);
  if (!ok) {
    DWORD error = GetLastError();
    if (!release && error == ERROR_LOCK_VIOLATION) {
      *acquired = false;
      return 0;
    }
    return error;
  }
#else
  int result;
#ifdef __APPLE__
  do {
    result =
        flock(fd, release ? LOCK_UN : (shared ? LOCK_SH : LOCK_EX) | LOCK_NB);
  } while (result < 0 && errno == EINTR);
#elif defined(__linux__)
  struct flock data = {0};
  data.l_type = release ? F_UNLCK : shared ? F_RDLCK : F_WRLCK;
  data.l_whence = SEEK_SET;
  do {
    result = fcntl(fd, F_OFD_SETLK, &data);
  } while (result < 0 && errno == EINTR);
#else
#error "Unsupported file locking platform"
#endif
  if (result < 0) {
    if (!release && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      *acquired = false;
      return 0;
    }
    return (unsigned long)errno;
  }
#endif
  *acquired = true;
  return 0;
}

static void cleanup(void *data) {
  lock_file *file = data;
  file->cleanup_registered = false;
  lock_handle fd = file->fd;
  file->fd = LOCK_CLOSED;
  if (fd != LOCK_CLOSED)
    close_handle(fd);
}

static void finalize(napi_env env, void *data, void *hint) {
  (void)hint;
  lock_file *file = data;
  if (file->cleanup_registered)
    napi_remove_env_cleanup_hook(env, cleanup, file);
  cleanup(file);
  free(file);
}

static lock_file *receiver(napi_env env, napi_callback_info info, size_t *argc,
                           napi_value *argv) {
  napi_value self;
  bool tagged = false;
  lock_file *file = NULL;
  if (napi_get_cb_info(env, info, argc, argv, &self, NULL) != napi_ok ||
      napi_check_object_type_tag(env, self, &lock_file_tag, &tagged) !=
          napi_ok ||
      !tagged || napi_unwrap(env, self, (void **)&file) != napi_ok ||
      file == NULL) {
    napi_throw_type_error(env, NULL, "Invalid lock file receiver");
    return NULL;
  }
  return file;
}

static napi_value try_lock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  lock_file *file = receiver(env, info, &argc, argv);
  if (!file)
    return NULL;
  bool shared = false;
  if (argc)
    NAPI(napi_get_value_bool(env, argv[0], &shared));
  bool acquired;
  unsigned long error = change_lock(file->fd, shared, false, &acquired);
  if (error)
    return system_error(env, error);
  napi_value value;
  NAPI(napi_get_boolean(env, acquired, &value));
  return value;
}

static napi_value unlock(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  lock_file *file = receiver(env, info, &argc, NULL);
  if (!file)
    return NULL;
  bool acquired;
  unsigned long error = change_lock(file->fd, false, true, &acquired);
  if (error)
    return system_error(env, error);
  return NULL;
}

static napi_value close_file(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  lock_file *file = receiver(env, info, &argc, NULL);
  if (!file)
    return NULL;
  lock_handle fd = file->fd;
  file->fd = LOCK_CLOSED;
  if (file->cleanup_registered) {
    napi_remove_env_cleanup_hook(env, cleanup, file);
    file->cleanup_registered = false;
  }
  unsigned long error = fd == LOCK_CLOSED ? 0 : close_handle(fd);
  if (error)
    return system_error(env, error);
  return NULL;
}

static napi_value stat_file(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  lock_file *file = receiver(env, info, &argc, NULL);
  if (!file)
    return NULL;
  struct lock_stat st;
  unsigned long error = read_stat(file->fd, &st);
  if (error)
    return system_error(env, error);
  napi_value result, value;
  NAPI(napi_create_object(env, &result));
#define FIELD(name, val)                                                       \
  NAPI(napi_create_bigint_uint64(env, (uint64_t)(val), &value));               \
  NAPI(napi_set_named_property(env, result, name, value))
  FIELD("dev", st.dev);
  FIELD("ino", st.ino);
  FIELD("mode", st.mode);
  FIELD("size", st.size);
  FIELD("nlink", st.nlink);
#undef FIELD
  return result;
}

static napi_value open_file(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (!argc) {
    napi_throw_type_error(env, NULL, "Path required");
    return NULL;
  }
  size_t length;
  NAPI(napi_get_value_string_utf8(env, argv[0], NULL, 0, &length));
  bool create = false;
  if (argc > 1)
    NAPI(napi_get_value_bool(env, argv[1], &create));
  lock_handle fd;
  unsigned long error;
#ifdef _WIN32
  NAPI(napi_get_value_string_utf16(env, argv[0], NULL, 0, &length));
  WCHAR *path = malloc((length + 1) * sizeof(WCHAR));
  if (!path) {
    napi_throw_error(env, "ENOMEM", "Out of memory");
    return NULL;
  }
  if (napi_get_value_string_utf16(env, argv[0], (char16_t *)path, length + 1,
                                  NULL) != napi_ok ||
      wcslen(path) != length) {
    free(path);
    napi_throw_type_error(env, "EINVAL", "Invalid path");
    return NULL;
  }
  fd = CreateFileW(path, GENERIC_READ | GENERIC_WRITE,
                   FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                   create ? CREATE_NEW : OPEN_EXISTING,
                   FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                   NULL);
  error = GetLastError();
#else
  char *path = malloc(length + 1);
  if (!path) {
    napi_throw_error(env, "ENOMEM", "Out of memory");
    return NULL;
  }
  if (napi_get_value_string_utf8(env, argv[0], path, length + 1, NULL) !=
          napi_ok ||
      strlen(path) != length) {
    free(path);
    napi_throw_type_error(env, "EINVAL", "Invalid path");
    return NULL;
  }
  int flags = O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;
  do {
    fd = open(path, flags | (create ? O_CREAT | O_EXCL : 0), 0600);
  } while (fd == LOCK_CLOSED && errno == EINTR);
  error = (unsigned long)errno;
#endif
  free(path);
  if (fd == LOCK_CLOSED)
    return system_error(env, error);
  lock_file *file = malloc(sizeof(*file));
  if (!file) {
    close_handle(fd);
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  file->fd = fd;
  file->cleanup_registered = false;
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_wrap(env, result, file, finalize, NULL, NULL) != napi_ok) {
    finalize(env, file, NULL);
    napi_throw_error(env, NULL, "Cannot wrap lock file");
    return NULL;
  }
  // Environment teardown can precede object finalization when a worker exits.
  if (napi_add_env_cleanup_hook(env, cleanup, file) != napi_ok) {
    cleanup(file);
    napi_throw_error(env, NULL, "Cannot register lock file cleanup");
    return NULL;
  }
  file->cleanup_registered = true;
  NAPI(napi_type_tag_object(env, result, &lock_file_tag));
  napi_property_descriptor methods[] = {
      {"tryLock", NULL, try_lock, NULL, NULL, NULL, napi_default, NULL},
      {"unlock", NULL, unlock, NULL, NULL, NULL, napi_default, NULL},
      {"close", NULL, close_file, NULL, NULL, NULL, napi_default, NULL},
      {"stat", NULL, stat_file, NULL, NULL, NULL, napi_default, NULL},
  };
  NAPI(napi_define_properties(env, result, 4, methods));
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value open;
  NAPI(napi_create_function(env, "open", NAPI_AUTO_LENGTH, open_file, NULL,
                            &open));
  NAPI(napi_set_named_property(env, exports, "open", open));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
