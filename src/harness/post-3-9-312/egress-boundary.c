#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <netdb.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>

static void record(const char *channel, const char *action, const char *target) {
  const char *path = getenv("PN_POST_312_BOUNDARY_LOG");
  if (!path) return;
  FILE *out = fopen(path, "a");
  if (!out) return;
  fprintf(out, "%s\t%s\t%s\t%ld\n", channel, action, target, (long)time(NULL));
  fclose(out);
}

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **result) {
  static int (*real_fn)(const char *, const char *, const struct addrinfo *, struct addrinfo **);
  if (!real_fn) real_fn = dlsym(RTLD_NEXT, "getaddrinfo");
  if (node && strcmp(node, "localhost") != 0) {
    record("dns", "getaddrinfo", node);
    return EAI_FAIL;
  }
  return real_fn(node, service, hints, result);
}

int connect(int fd, const struct sockaddr *address, socklen_t length) {
  static int (*real_fn)(int, const struct sockaddr *, socklen_t);
  if (!real_fn) real_fn = dlsym(RTLD_NEXT, "connect");
  char target[128] = "unknown";
  int allowed = 0, port = 0;
  if (address && address->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)address;
    inet_ntop(AF_INET, &in->sin_addr, target, sizeof(target));
    port = ntohs(in->sin_port);
    allowed = ntohl(in->sin_addr.s_addr) == INADDR_LOOPBACK;
  } else if (address && address->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)address;
    inet_ntop(AF_INET6, &in6->sin6_addr, target, sizeof(target));
    port = ntohs(in6->sin6_port);
    allowed = IN6_IS_ADDR_LOOPBACK(&in6->sin6_addr);
  } else if (address && address->sa_family == AF_UNIX) {
    allowed = 1;
  }
  if (!allowed) {
    char endpoint[160];
    snprintf(endpoint, sizeof(endpoint), "%s:%d", target, port);
    const char *channel =
      port == 443 ? "vlm" :
      port == 80 ? "http" :
      port == 5555 ? "device" :
      port == 18791 ? "phone_dispatch" : "ws";
    record(channel, "connect", endpoint);
    errno = EACCES;
    return -1;
  }
  return real_fn(fd, address, length);
}

static int forbidden(const char *path, const char **channel) {
  const char *base = strrchr(path ? path : "", '/');
  base = base ? base + 1 : path;
  if (base && strcmp(base, "adb") == 0) { *channel = "device"; return 1; }
  if (base && strcmp(base, "phone-dispatch") == 0) { *channel = "phone_dispatch"; return 1; }
  return 0;
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attrs, char *const argv[], char *const envp[]) {
  static int (*real_fn)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                        const posix_spawnattr_t *, char *const[], char *const[]);
  if (!real_fn) real_fn = dlsym(RTLD_NEXT, "posix_spawn");
  const char *channel = NULL;
  if (forbidden(path, &channel)) { record(channel, "posix_spawn", path); return EACCES; }
  return real_fn(pid, path, actions, attrs, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attrs, char *const argv[], char *const envp[]) {
  static int (*real_fn)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                        const posix_spawnattr_t *, char *const[], char *const[]);
  if (!real_fn) real_fn = dlsym(RTLD_NEXT, "posix_spawnp");
  const char *channel = NULL;
  if (forbidden(file, &channel)) { record(channel, "posix_spawnp", file); return EACCES; }
  return real_fn(pid, file, actions, attrs, argv, envp);
}

int execve(const char *path, char *const argv[], char *const envp[]) {
  static int (*real_fn)(const char *, char *const[], char *const[]);
  if (!real_fn) real_fn = dlsym(RTLD_NEXT, "execve");
  const char *channel = NULL;
  if (forbidden(path, &channel)) {
    record(channel, "execve", path);
    errno = EACCES;
    return -1;
  }
  return real_fn(path, argv, envp);
}

int execvp(const char *file, char *const argv[]) {
  static int (*real_fn)(const char *, char *const[]);
  if (!real_fn) real_fn = dlsym(RTLD_NEXT, "execvp");
  const char *channel = NULL;
  if (forbidden(file, &channel)) {
    record(channel, "execvp", file);
    errno = EACCES;
    return -1;
  }
  return real_fn(file, argv);
}
