// main.go -- the entry's lifecycle, and nothing else.
//
// The forge lives in the rest of this package. This file only does the four things the trial
// contract asks of the process it starts:
//
//  1. bind an ephemeral port -- listen(0) on 0.0.0.0, never 8080, which the env owns on the
//     one-pod layout;
//  2. announce that port with POST $MAKEFUN_ENV_URL/register {"port": N};
//  3. poll GET $MAKEFUN_ENV_URL/done until the body carries done === true;
//  4. close the listener and exit 0.
//
// The env is dialled over one keep-alive client: the done poll runs for the whole trial alongside
// a 2,000-request benchmark, so it must not cost a fresh socket every time, and it must never hold
// a request open -- the env answers a poll at once, and the waiting happens here, between calls.

package main

import (
	"bytes"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"runtime/pprof"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// tag is the prefix every line this file writes to stderr starts with.
const tag = "[entry]"

// envPort is the env's own port: an ephemeral bind must never land on it.
const envPort = 8080

const (
	registerTimeout    = 5 * time.Second
	registerWait       = 100 * time.Millisecond
	registerWaitMax    = 2 * time.Second
	doneTimeout        = 10 * time.Second
	doneWait           = 250 * time.Millisecond
	doneWaitMax        = 2 * time.Second
	shutdownGraceOnEnd = 0
)

// logBroken latches once a write to stderr has failed: a forge whose log reader has gone away
// must not spend the rest of the trial discovering that again.
var logBroken atomic.Bool

// note writes one diagnostic line. It can never panic and gives up after the first failure.
func note(prefix string, line string) {
	if logBroken.Load() {
		return
	}
	defer func() {
		if recover() != nil {
			logBroken.Store(true)
		}
	}()
	if _, err := os.Stderr.WriteString(prefix + " " + line + "\n"); err != nil {
		logBroken.Store(true)
	}
}

func describeRecovered(recovered any) string {
	switch typed := recovered.(type) {
	case error:
		return typed.Error()
	case string:
		return typed
	}
	return fmt.Sprint(recovered)
}

func logEntry(line string) {
	note(tag, line)
}

// backoff is an exponential wait, doubled per attempt and capped.
func backoff(attempt int, first time.Duration, cap time.Duration) time.Duration {
	wait := first
	for index := 0; index < attempt && wait < cap; index++ {
		wait *= 2
	}
	if wait > cap {
		return cap
	}
	return wait
}

// worthLogging reports whether a repeated failure is worth a line. An env that never answers
// would otherwise fill the trial's log with one line every two seconds for fifteen minutes.
func worthLogging(attempt int) bool {
	return attempt < 3 || attempt%10 == 0
}

// envTarget is the env's origin, split once.
type envTarget struct {
	scheme string
	host   string
	prefix string
}

func (t envTarget) url(path string) string {
	return t.scheme + "://" + t.host + t.prefix + path
}

// envOrigin reads MAKEFUN_ENV_URL. An unset variable is fatal at once: there is nothing to
// register with, so staying up would only burn the trial's wall clock.
func envOrigin() envTarget {
	raw := strings.TrimRight(strings.TrimSpace(os.Getenv("MAKEFUN_ENV_URL")), "/")
	if raw == "" {
		logEntry("MAKEFUN_ENV_URL is unset: no env to register with")
		os.Exit(1)
	}
	scheme := "http"
	rest := raw
	if mark := strings.Index(raw, "://"); mark >= 0 {
		scheme = strings.ToLower(raw[:mark])
		rest = raw[mark+3:]
	}
	if scheme != "http" && scheme != "https" {
		logEntry("MAKEFUN_ENV_URL is not a URL: " + raw)
		os.Exit(1)
	}
	host := rest
	prefix := ""
	if slash := strings.IndexByte(rest, '/'); slash >= 0 {
		host = rest[:slash]
		prefix = strings.TrimRight(rest[slash:], "/")
	}
	if host == "" {
		logEntry("MAKEFUN_ENV_URL is not a URL: " + raw)
		os.Exit(1)
	}
	return envTarget{scheme: scheme, host: host, prefix: prefix}
}

// answer is what one env call came back with.
type answer struct {
	status int
	body   string
}

// call makes one request to the env, with its own timeout, over the shared keep-alive connection.
func call(client *envClient, method string, path string, payload string, timeout time.Duration) (answer, error) {
	return client.do(method, path, payload, timeout)
}

// doneReported reports whether a /done body says the suite is over.
func doneReported(body string) bool {
	parsed, ok := parseJSON([]byte(body))
	if !ok {
		return false
	}
	value, held := jboolOk(jsonObj(parsed), "done")
	return held && value
}

// bind takes an ephemeral port. A rebind keeps the promise the contract makes -- never the env's
// own port -- rather than trusting the local port range.
func bind(server *forgeServer) (int, error) {
	for left := 4; ; left-- {
		port, err := server.listen()
		if err != nil {
			return 0, err
		}
		if port != envPort || left == 0 {
			return port, nil
		}
		logEntry("listen(0) handed out " + strconv.Itoa(envPort) + ", which is the env's: rebinding")
		if err := server.rebind(); err != nil {
			return port, nil
		}
	}
}

// announce tells the env where we listen. A 2xx is the first register; a 409 means a register
// already landed for this entry, which counts as registered just the same. Anything else is worth
// another attempt: the boot budget is the only real deadline and giving up early scores nothing.
func announce(client *envClient, port int) {
	payload := `{"port":` + strconv.Itoa(port) + `}`
	for attempt := 0; ; attempt++ {
		result, err := call(client, "POST", "/register", payload, registerTimeout)
		if err == nil {
			if result.status >= 200 && result.status < 300 {
				logEntry("registered port " + strconv.Itoa(port) + " with the env")
				return
			}
			if result.status == 409 {
				logEntry("the env already has a register for this entry (409); port " + strconv.Itoa(port) + " stands")
				return
			}
			if worthLogging(attempt) {
				logEntry("register answered " + strconv.Itoa(result.status) + ": " + clip(result.body))
			}
		} else if worthLogging(attempt) {
			logEntry("register attempt " + strconv.Itoa(attempt+1) + " failed: " + err.Error())
		}
		time.Sleep(backoff(attempt, registerWait, registerWaitMax))
	}
}

// awaitDone polls until the suite is over. Each request carries its own timeout and is never held
// open; the wait between polls grows to a couple of seconds so the poll stays invisible next to
// the benchmark. A failed poll is not fatal: the env may be busy exporting.
func awaitDone(client *envClient) {
	quiet := false
	for attempt := 0; ; attempt++ {
		result, err := call(client, "GET", "/done", "", doneTimeout)
		if err == nil {
			if result.status >= 200 && result.status < 300 {
				if doneReported(result.body) {
					logEntry("the env reports the suite is done")
					return
				}
				quiet = false
			} else if !quiet {
				quiet = true
				logEntry("done answered " + strconv.Itoa(result.status) + ": " + clip(result.body))
			}
		} else if !quiet {
			quiet = true
			logEntry("done poll failed: " + err.Error())
		}
		time.Sleep(backoff(attempt, doneWait, doneWaitMax))
	}
}

func clip(text string) string {
	trimmed := strings.TrimSpace(text)
	if len(trimmed) > 200 {
		return trimmed[:200]
	}
	return trimmed
}

// dumpStats answers a SIGUSR2 with the counters tools/bench.mjs reads. The GC figures come from
// ReadGCStats rather than MemStats: it reads the same totals without stopping the world.
func dumpStats() {
	var collected debug.GCStats
	debug.ReadGCStats(&collected)
	var line bytes.Buffer
	line.WriteString(`[forge-stats] {"responses":`)
	line.WriteString(strconv.FormatUint(statResponses.Load(), 10))
	line.WriteString(`,"writes":`)
	line.WriteString(strconv.FormatUint(statWrites.Load(), 10))
	line.WriteString(`,"reads":`)
	line.WriteString(strconv.FormatUint(statReads.Load(), 10))
	line.WriteString(`,"readBytes":`)
	line.WriteString(strconv.FormatUint(statReadBytes.Load(), 10))
	line.WriteString(`,"gcMs":`)
	line.WriteString(strconv.FormatFloat(float64(collected.PauseTotal.Nanoseconds())/1e6, 'f', 3, 64))
	line.WriteString(`,"gcMajorMs":0,"gcCount":`)
	line.WriteString(strconv.FormatInt(collected.NumGC, 10))
	line.WriteString("}\n")
	os.Stderr.Write(line.Bytes())
}

// profiling is the CPU profile a SIGUSR1 starts and the next SIGUSR1 stops. It exists only when
// FORGE_PROF names a file, so a trial never carries the profiler's overhead.
var profiling *os.File

// toggleProfile starts or stops the CPU profile FORGE_PROF names.
func toggleProfile() {
	path := os.Getenv("FORGE_PROF")
	if path == "" {
		return
	}
	if profiling != nil {
		pprof.StopCPUProfile()
		profiling.Close()
		profiling = nil
		logEntry("wrote the CPU profile to " + path)
		return
	}
	file, err := os.Create(path)
	if err != nil {
		logEntry("could not open " + path + ": " + err.Error())
		return
	}
	if err := pprof.StartCPUProfile(file); err != nil {
		logEntry("could not start the CPU profile: " + err.Error())
		file.Close()
		return
	}
	profiling = file
	logEntry("started a CPU profile into " + path)
}

// tune sets the runtime knobs for the trial pod: two CPUs, a gigabyte of memory, and a store that
// only grows, so a lazier collector is the right trade.
func tune() {
	if runtime.GOMAXPROCS(0) > 2 {
		runtime.GOMAXPROCS(2)
	}
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(400)
	}
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(720 << 20)
	}
}

func main() {
	tune()
	target := envOrigin()
	client := newEnvClient(target)

	forge := newApp()
	server := newForgeServer(forge.route)

	// The harness SIGTERMs the entry when the trial ends; that is a clean finish, not a failure.
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	usr2 := make(chan os.Signal, 1)
	signal.Notify(usr2, syscall.SIGUSR2)
	go func() {
		for range usr2 {
			dumpStats()
		}
	}()
	usr1 := make(chan os.Signal, 1)
	signal.Notify(usr1, syscall.SIGUSR1)
	go func() {
		for range usr1 {
			toggleProfile()
		}
	}()
	go func() {
		received := <-signals
		logEntry(received.String() + ": shutting down")
		server.closeAll()
		os.Exit(0)
	}()

	port, err := bind(server)
	if err != nil {
		logEntry("the listener could not bind: " + err.Error())
		os.Exit(1)
	}
	logEntry("the forge is listening on port " + strconv.Itoa(port))
	go server.serve()

	announce(client, port)
	awaitDone(client)
	server.closeAll()
	os.Exit(0)
}
