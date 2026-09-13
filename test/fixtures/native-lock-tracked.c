#ifndef _WIN32
#define _GNU_SOURCE
#endif
#include <node_api.h>
#include <stdlib.h>
#ifdef _WIN32
#include <windows.h>
static volatile LONG live_allocations;
static void track(int delta) {
  InterlockedExchangeAdd(&live_allocations, delta);
}
static unsigned int count(void) {
  return (unsigned int)InterlockedCompareExchange(&live_allocations, 0, 0);
}
#else
#include <stdatomic.h>
static atomic_uint live_allocations;
static void track(int delta) { atomic_fetch_add(&live_allocations, delta); }
static unsigned int count(void) { return atomic_load(&live_allocations); }
#endif

static void *tracked_malloc(size_t size) {
  void *allocation = malloc(size);
  if (allocation != NULL)
    track(1);
  return allocation;
}
static void tracked_free(void *allocation) {
  if (allocation != NULL)
    track(-1);
  free(allocation);
}

/* Count allocations in the real implementation without a production test API.
 */
#define malloc tracked_malloc
#define free tracked_free
#undef NAPI_MODULE
#define NAPI_MODULE(name, callback)
#include "../../native/file-lock.c"
#undef malloc
#undef free

static napi_value outstanding(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  NAPI(napi_create_uint32(env, count(), &result));
  return result;
}

NAPI_MODULE_INIT() {
  if (init(env, exports) == NULL)
    return NULL;
  napi_value method;
  NAPI(napi_create_function(env, "outstanding", NAPI_AUTO_LENGTH, outstanding,
                            NULL, &method));
  NAPI(napi_set_named_property(env, exports, "outstanding", method));
  return exports;
}
