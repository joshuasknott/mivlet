#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

/* The trusted broker starts one fixed GUI ELF. Its dynamic loader needs EXEC
 * during startup; once loaded, forbid every subsequent exec before app/UI code
 * runs. Seccomp also closes execveat/memfd routes outside filesystem paths. */
__attribute__((constructor)) static void close_gui_execution(void) {
    uint64_t handled_execute = 1;
    int rules = syscall(SYS_landlock_create_ruleset, &handled_execute, sizeof(handled_execute), 0);
    if (rules < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
        syscall(SYS_landlock_restrict_self, rules, 0)) _exit(126);
    close(rules);
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_execve, 1, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_execveat, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) _exit(126);
    const char *ready = getenv("FABLE_GUI_READY_FD");
    if (ready) {
        char *end = NULL;
        long descriptor = strtol(ready, &end, 10);
        if (!end || *end || descriptor < 3 || descriptor > 1024 || write((int)descriptor, "1", 1) != 1) _exit(126);
        close((int)descriptor);
    }
    unsetenv("FABLE_GUI_READY_FD");
    unsetenv("LD_PRELOAD");
}
