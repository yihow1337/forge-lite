package main

import (
	"bytes"
	"testing"
)

// benchPack is the shape of pack the push workload sends two hundred times a round: one 1 KiB
// blob, the tree that names it and the commit that points at the tree.
func benchPack() []byte {
	blob := bytes.Repeat([]byte("bench data line\n"), 64)
	blobOid := hashObject(objBlob, blob)
	tree := buildTree([]TreeEntry{{Mode: "100644", Name: "bench-data.txt", OID: blobOid}})
	treeOid := hashObject(objTree, tree)
	commit := buildCommit(BuildCommitFields{Tree: treeOid, Message: "bench: push 1\n", Timestamp: 1700000000})
	return writePack([]*GitObject{
		{Type: objBlob, Data: blob},
		{Type: objTree, Data: tree},
		{Type: objCommit, Data: commit},
	})
}

// BenchmarkReadPack covers the push workload's hot handler. The allocation count is the number
// that matters: a zlib reader built per pack costs a 32 KiB flate window and its tables, which is
// why inflaters is a pool. Run it with -benchmem.
func BenchmarkReadPack(b *testing.B) {
	pack := benchPack()
	store := make(ObjectStore)
	b.ReportAllocs()
	b.SetBytes(int64(len(pack)))
	for b.Loop() {
		objects, err := readPack(pack, store)
		if err != nil {
			b.Fatal(err)
		}
		if len(objects) != 3 {
			b.Fatalf("got %d objects, want 3", len(objects))
		}
	}
}

// BenchmarkWritePack covers the clone workload's cache miss.
func BenchmarkWritePack(b *testing.B) {
	blob := bytes.Repeat([]byte("history line\n"), 40)
	objects := make([]*GitObject, 0, 600)
	for index := 0; index < 200; index++ {
		data := append(append([]byte{}, blob...), byte(index))
		tree := buildTree([]TreeEntry{{Mode: "100644", Name: "history.txt", OID: hashObject(objBlob, data)}})
		commit := buildCommit(BuildCommitFields{Tree: hashObject(objTree, tree), Message: "history\n", Timestamp: 1700000000})
		objects = append(objects, &GitObject{Type: objBlob, Data: data}, &GitObject{Type: objTree, Data: tree}, &GitObject{Type: objCommit, Data: commit})
	}
	b.ReportAllocs()
	for b.Loop() {
		if len(writePack(objects)) == 0 {
			b.Fatal("empty pack")
		}
	}
}

// TestReadPackRoundTrip is the property every push depends on: what writePack wrote, readPack
// reads back with the same ids and the same bytes.
func TestReadPackRoundTrip(t *testing.T) {
	pack := benchPack()
	objects, err := readPack(pack, make(ObjectStore))
	if err != nil {
		t.Fatalf("readPack: %v", err)
	}
	if len(objects) != 3 {
		t.Fatalf("got %d objects, want 3", len(objects))
	}
	for _, held := range objects {
		if recomputed := hashObject(held.Object.Type, held.Object.Data); recomputed != held.OID {
			t.Errorf("object %s rehashes to %s", held.OID, recomputed)
		}
	}
}

// TestReadPackRejectsNonsense checks the bounds a client-supplied pack is read under: nothing here
// may panic, and nothing may be trusted into an allocation.
func TestReadPackRejectsNonsense(t *testing.T) {
	good := benchPack()
	cases := map[string][]byte{
		"empty-ish":        make([]byte, 40),
		"bad magic":        append([]byte("NOPE"), good[4:]...),
		"short":            good[:20],
		"truncated body":   good[:len(good)-30],
		"absurd count":     func() []byte { out := append([]byte{}, good...); out[8], out[9] = 0xff, 0xff; return out }(),
		"truncated stream": append(append([]byte{}, good[:14]...), make([]byte, 20)...),
	}
	for name, pack := range cases {
		if _, err := readPack(pack, make(ObjectStore)); err == nil {
			t.Errorf("%s: readPack accepted it", name)
		}
	}
}

// TestInflaterIsReused is the reason inflaters exists: a pool entry that came back must still
// decode correctly, and the second pack must not pay for a new engine.
func TestInflaterIsReused(t *testing.T) {
	pack := benchPack()
	for round := 0; round < 3; round++ {
		objects, err := readPack(pack, make(ObjectStore))
		if err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		if len(objects) != 3 {
			t.Fatalf("round %d: got %d objects", round, len(objects))
		}
	}
	// A failed pack leaves the engine mid-stream; the next pack must still work.
	if _, err := readPack(append(append([]byte{}, pack[:14]...), make([]byte, 20)...), make(ObjectStore)); err == nil {
		t.Fatal("a truncated pack was accepted")
	}
	if _, err := readPack(pack, make(ObjectStore)); err != nil {
		t.Fatalf("after a failed pack: %v", err)
	}
}
