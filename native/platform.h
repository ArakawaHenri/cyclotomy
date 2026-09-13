#ifndef CYCLOTOMY_LOCK_PLATFORM_H
#define CYCLOTOMY_LOCK_PLATFORM_H

#include <stdbool.h>
#include <stdint.h>

struct lock_stat {
  uint64_t dev, ino, mode, nlink, size;
};

#ifdef _WIN32
#include <windows.h>
typedef HANDLE lock_handle;
#define LOCK_CLOSED INVALID_HANDLE_VALUE
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/file.h>
#endif
typedef int lock_handle;
#define LOCK_CLOSED (-1)
#endif

#endif
