#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

extern char **environ;

static const char *lab_case = "";

/* Task 245 protocol fixture; only the supervisor's exact-hash profile may approve it. */
#define PROVIDER "/usr/libexec/clawwright-native-provider"
#define SOCKET_PATH "/run/clawwright-native.sock"
#define REQUEST "{\"protocolVersion\":1,\"provider\":\"clawwright-ssjack\",\"ids\":[\"gateway-token\"]}"
#define EXPECTED "{\"protocolVersion\":1,\"values\":{\"gateway-token\":\"scoped secret\"}}\n"

static int send_reader(int fd, int reader) {
    char byte = 'F', control[CMSG_SPACE(sizeof(int))] = {0};
    struct iovec io = { &byte, 1 };
    struct msghdr msg = {0};
    msg.msg_iov = &io; msg.msg_iovlen = 1;
    msg.msg_control = control; msg.msg_controllen = sizeof control;
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &reader, sizeof reader);
    return sendmsg(fd, &msg, 0) == 1 ? 0 : -1;
}

static int broker(void) {
    int ctrl = 3, out[2], input[2];
    if (!strcmp(lab_case, "unexpected-exec")) {
        char *const av[] = { (char *)"/usr/bin/node", (char *)"unexpected", NULL };
        execve("/usr/bin/node", av, environ);
        return 25;
    }
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, out) || pipe(input)) return 20;
    pid_t child = fork();
    if (child < 0) return 21;
    if (!child) {
        int in = fcntl(input[0], F_DUPFD_CLOEXEC, 10), writer = fcntl(out[1], F_DUPFD_CLOEXEC, 10);
        if (in < 0 || writer < 0 || dup2(in, 0) < 0 || dup2(writer, 1) < 0) _exit(126);
        for (int fd = 3; fd < 1024; ++fd) close(fd);
        char *const av[] = { (char *)PROVIDER, NULL };
        char *const ev[] = { "CLAWWRIGHT_NATIVE_SOCKET=" SOCKET_PATH, NULL };
        execve(PROVIDER, av, ev); _exit(127);
    }
    close(input[0]);
    if (strcmp(lab_case, "wrong-holder")) close(out[1]);
    size_t left = sizeof REQUEST - 1; const char *p = REQUEST;
    while (left) { ssize_t n = write(input[1], p, left); if (n <= 0) return 22; p += n; left -= (size_t)n; }
    close(input[1]);
    if (send_reader(ctrl, out[0])) return 23;
    close(out[0]);
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) return 24;
    /* Keep the approved broker alive until the supervisor terminates the fixture. */
    for (;;) pause();
}

static int receive_capture(int ctrl) {
    char byte, data[4097];
    struct iovec io = { &byte, 1 };
    char control[CMSG_SPACE(sizeof(int))] = {0};
    struct msghdr msg = {0};
    msg.msg_iov = &io; msg.msg_iovlen = 1; msg.msg_control = control; msg.msg_controllen = sizeof control;
    if (recvmsg(ctrl, &msg, 0) != 1 || byte != 'F' || (msg.msg_flags & MSG_CTRUNC)) return 30;
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    if (!c || c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS || c->cmsg_len != CMSG_LEN(sizeof(int))) return 31;
    int reader; memcpy(&reader, CMSG_DATA(c), sizeof reader);
    size_t used = 0;
    while (used < sizeof data - 1) {
        ssize_t n = read(reader, data + used, sizeof data - 1 - used);
        if (n <= 0) { close(reader); return 32; }
        used += (size_t)n;
        if (memchr(data, '\n', used)) break;
    }
    close(reader); data[used] = 0;
    if (used != sizeof EXPECTED - 1 || memcmp(data, EXPECTED, used)) return 33;
    memset(data, 0, sizeof data);
    return 0;
}

static int gateway(const char *self) {
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) return 40;
    pid_t child = fork();
    if (child < 0) return 41;
    if (!child) {
        int ipc = fcntl(pair[1], F_DUPFD_CLOEXEC, 10);
        if (ipc < 0 || dup2(ipc, 3) < 0) _exit(126);
        int flags = fcntl(3, F_GETFD); if (flags < 0 || fcntl(3, F_SETFD, flags & ~FD_CLOEXEC) < 0) _exit(126);
        for (int fd = 4; fd < 1024; ++fd) close(fd);
        char *av[] = { (char *)"/usr/bin/node", (char *)"broker", (char *)lab_case, NULL };
        if (!*lab_case) av[2] = NULL;
        execve("/usr/bin/node", av, environ); _exit(127);
    }
    close(pair[1]);
    int result = receive_capture(pair[0]);
    close(pair[0]);
    if (result) return result;
    int marker = open("/run/native-capture-ok", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (marker < 0) return 42;
    static const char proof[] = "OCCAP001";
    size_t written = 0;
    while (written < sizeof proof - 1) {
        ssize_t n = write(marker, proof + written, sizeof proof - 1 - written);
        if (n <= 0) { close(marker); return 43; }
        written += (size_t)n;
    }
    if (fsync(marker) || close(marker)) return 44;
    /* Keep the gateway alive until supervisor cleanup, allowing provider acknowledgement. */
    for (;;) pause();
}

int main(int argc, char **argv) {
    if (argc == 3 && (!strcmp(argv[2], "wrong-holder") || !strcmp(argv[2], "unexpected-exec"))) lab_case = argv[2];
    else if (argc != 2) return 2;
    if (!strcmp(argv[1], "gateway")) return gateway(argv[0]);
    if (!strcmp(argv[1], "broker")) return broker();
    return 2;
}
