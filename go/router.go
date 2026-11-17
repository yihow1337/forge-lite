// The forge's HTTP surface: one server, four APIs.
//
//	/healthz               the env's boot probe
//	/api/v3/…              the GitHub REST v3 API
//	/api/graphql           the GraphQL v4 API
//	/mcp                   the Model Context Protocol endpoint
//	/{owner}/{repo}.git/…  git smart HTTP (upload-pack v2, receive-pack v0)
//
// main.go owns the lifecycle; this file owns the routing. A port of app.ts.
//
// One mutex guards the whole store. Node served this forge on one thread, and the suite's two
// hot paths are a single keep-alive connection (the read workload) and fifty clones that all
// replay one cached buffer, so there is no parallelism to win here -- but there is determinism
// to lose: two concurrent mutations interleaving would make the id counters depend on arrival
// order. The lock is held for the handler only, never across a socket write.

package main

import "sync"

// defaultViewer is the login the suite's seeded scenario gives the token; the first owner a
// request names wins.
const defaultViewer = "adaiversen"

const jsonType = "application/json; charset=utf-8"

var (
	healthzReply  = Reply{Status: 200, Type: jsonType, Body: []byte(`{"ok":true}`), Stamp: true}
	notFoundReply = Reply{Status: 404, Type: jsonType, Stamp: true,
		Body: []byte(`{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}`)}
	graphqlUnauthorized = Reply{Status: 401, Type: jsonType, Stamp: true,
		Body: []byte(`{"message":"Requires authentication","documentation_url":"https://docs.github.com/graphql"}`)}
	graphqlMethod   = Reply{Status: 405, Type: jsonType, Body: []byte(`{"message":"Only POST is supported"}`), Stamp: true}
	graphqlBadJSON  = Reply{Status: 400, Type: jsonType, Body: []byte(`{"errors":[{"message":"Problems parsing JSON"}]}`), Stamp: true}
	gitCacheHeaders = []hdr{{"cache-control", "no-cache"}}
)

type app struct {
	mu    sync.Mutex
	store *Store
}

func newApp() *app {
	return &app{store: newStore(defaultViewer)}
}

func (a *app) route(request *Request) Reply {
	path := request.Path

	if len(path) > 1 && path[1] == 'a' && len(path) >= 7 && path[:7] == "/api/v3" {
		tail := path[7:]
		if tail == "" || tail[0] == '/' {
			var parsed any
			badJSON := false
			if len(request.Body) > 0 {
				value, ok := parseJSON(request.Body)
				if ok {
					parsed = value
				} else {
					badJSON = true
				}
			}
			a.mu.Lock()
			reply := handleRest(a.store, &ApiRequest{
				Method:     request.Method,
				Segments:   segmentsOf(tail),
				Query:      request.Query,
				JSON:       parsed,
				BadJSON:    badJSON,
				Authorized: request.Authorized,
				Host:       request.Host,
			})
			a.mu.Unlock()
			return Reply{Status: reply.Status, Type: jsonType, Body: reply.Body, Headers: reply.Headers, Stamp: true}
		}
	}

	if path == "/api/graphql" || path == "/graphql" {
		if !request.Authorized {
			return graphqlUnauthorized
		}
		if request.Method != "POST" {
			return graphqlMethod
		}
		parsed, ok := parseJSON(request.Body)
		if !ok {
			return graphqlBadJSON
		}
		b := &jb{buf: make([]byte, 0, 1024)}
		a.mu.Lock()
		if batch, isBatch := parsed.([]any); isBatch {
			b.openArray()
			for _, entry := range batch {
				b.item()
				executeGraphQL(b, a.store, entry)
				b.comma = true
			}
			b.closeArray()
		} else {
			executeGraphQL(b, a.store, parsed)
		}
		a.mu.Unlock()
		return Reply{Status: 200, Type: jsonType, Body: b.buf, Stamp: true}
	}

	if path == "/mcp" || path == "/mcp/" {
		a.mu.Lock()
		reply := handleMcp(a.store, request.Method, request.Authorized, request.Body)
		a.mu.Unlock()
		if len(reply.Body) == 0 {
			status := reply.Status
			if status == 200 {
				status = 202
			}
			return Reply{Status: status}
		}
		return Reply{Status: reply.Status, Type: "application/json", Body: reply.Body}
	}

	if path == "/healthz" || path == "/health" || path == "/healthz/" {
		return healthzReply
	}

	a.mu.Lock()
	git := handleGit(a.store, &GitHttpRequest{
		Method:        request.Method,
		Segments:      segmentsOf(path),
		Query:         request.Query,
		GitProtocolV2: request.GitProtocolV2,
		Body:          request.Body,
	})
	a.mu.Unlock()
	if git != nil {
		return Reply{Status: git.Status, Type: git.Type, Body: git.Body, Headers: gitCacheHeaders}
	}

	return notFoundReply
}
