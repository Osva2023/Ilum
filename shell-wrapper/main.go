// agentguard-shell — shell wrapper that forwards `sh -c <cmd>` invocations
// to the AgentGuard adjudication daemon for classification before exec.
//
// AgentGuard sets SHELL=<this binary> in the agent's environment so every
// child shell call from the agent (Node's child_process.exec, libuv exec*,
// etc.) routes through us.  We send the command to the daemon over a Unix
// socket; the daemon classifies and either approves (we exec /bin/sh) or
// denies (we exit 126 so the agent sees a normal command failure).
//
// Wire protocol (line-delimited JSON):
//   →  {"v":1,"cmd":"rm -rf foo","cwd":"/path","ppid":12345}
//   ←  {"v":1,"outcome":"approved"}                                 // or
//   ←  {"v":1,"outcome":"denied","reason":"rm -rf with sudo"}
//
// Behaviour matrix:
//
//   AGENTGUARD_SESSION_ID set | -c invocation | daemon reachable | action
//   ─────────────────────────────────────────────────────────────────────
//   yes                      | yes           | yes              | adjudicate
//   yes                      | yes           | no               | fail-CLOSED, exit 126
//   yes                      | no            | —                | exec /bin/sh "$@"
//   no                       | —             | —                | exec /bin/sh "$@"
//
// Limitation: only matches `-c` as a standalone argument, not combined
// short-option clusters like `-lc`.  In practice every callable shell
// invoker (Node, libuv, Python subprocess, Go os/exec) uses a clean `-c`.

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"syscall"
	"time"
)

const (
	defaultShell      = "/bin/sh"
	denyExitCode      = 126
	execFailExitCode  = 127
	dialTimeout       = 2 * time.Second
	responseTimeout   = 5 * time.Minute // user prompts can be slow
)

type request struct {
	V    int    `json:"v"`
	Cmd  string `json:"cmd"`
	Cwd  string `json:"cwd"`
	Ppid int    `json:"ppid"`
}

type response struct {
	V       int    `json:"v"`
	Outcome string `json:"outcome"`
	Reason  string `json:"reason,omitempty"`
}

func main() {
	args := os.Args[1:]

	cmdIdx := findDashC(args)
	sessionID := os.Getenv("AGENTGUARD_SESSION_ID")
	socketPath := os.Getenv("AGENTGUARD_SOCKET")

	// Pass-through cases.  When no session is active we are likely on the
	// user's interactive shell (SHELL leaked) — we must not block anything.
	if cmdIdx == -1 || sessionID == "" {
		passthrough(args)
		return
	}

	// Misconfiguration: session active but socket address missing.  We have
	// no way to reach the daemon, so fail-closed per the contract.
	if socketPath == "" {
		fmt.Fprintln(os.Stderr,
			"[AgentGuard] AGENTGUARD_SESSION_ID set but AGENTGUARD_SOCKET missing — blocking command.")
		os.Exit(denyExitCode)
	}

	cmd := args[cmdIdx+1]
	cwd, _ := os.Getwd()

	resp, err := adjudicate(socketPath, request{
		V:    1,
		Cmd:  cmd,
		Cwd:  cwd,
		Ppid: os.Getppid(),
	})
	if err != nil {
		// Fail-CLOSED: session is active and daemon unreachable.
		fmt.Fprintf(os.Stderr,
			"[AgentGuard] adjudication daemon unreachable (%v) — blocking command.\n", err)
		os.Exit(denyExitCode)
	}

	switch resp.Outcome {
	case "approved":
		passthrough(args)
	case "denied":
		if resp.Reason != "" {
			fmt.Fprintf(os.Stderr, "[AgentGuard] Command blocked: %s\n", resp.Reason)
		} else {
			fmt.Fprintln(os.Stderr, "[AgentGuard] Command blocked.")
		}
		os.Exit(denyExitCode)
	default:
		fmt.Fprintf(os.Stderr,
			"[AgentGuard] daemon returned unexpected outcome %q — blocking command.\n",
			resp.Outcome)
		os.Exit(denyExitCode)
	}
}

// findDashC returns the index of the command string after `-c`, or -1 if
// argv does not contain a `-c` flag with a following value.
func findDashC(args []string) int {
	for i, a := range args {
		if a == "-c" && i+1 < len(args) {
			return i
		}
	}
	return -1
}

// adjudicate connects to the daemon, sends one request line, and reads one
// response line.  Connection close after the exchange is the daemon's job.
func adjudicate(socketPath string, req request) (*response, error) {
	conn, err := net.DialTimeout("unix", socketPath, dialTimeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if err := conn.SetDeadline(time.Now().Add(responseTimeout)); err != nil {
		return nil, err
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(body, '\n')); err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}

	// Read until newline; bufio.Scanner is the simplest fit.
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 4096), 64*1024)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return nil, fmt.Errorf("read: %w", err)
		}
		return nil, fmt.Errorf("daemon closed connection before responding")
	}

	var resp response
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return nil, fmt.Errorf("malformed response: %w", err)
	}
	return &resp, nil
}

// passthrough execs /bin/sh with the original argv preserved exactly.  We
// use syscall.Exec (not os/exec.Cmd) so the agent's expectation of one
// shell process / one exit code / direct stdio attachment holds.
func passthrough(args []string) {
	argv := append([]string{defaultShell}, args...)
	if err := syscall.Exec(defaultShell, argv, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "[AgentGuard] exec %s failed: %v\n", defaultShell, err)
		os.Exit(execFailExitCode)
	}
}

