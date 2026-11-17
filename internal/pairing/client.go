package pairing

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"

	"filippo.io/cpace"
)

var (
	// ErrUnreachable means no address in the code answered: not on the same
	// Wi-Fi, a network that keeps devices apart, or (on iOS) Local Network
	// access turned off for Peli.
	ErrUnreachable = errors.New("pairing: can't reach the other device")
	// ErrNoSender means no Mac on this network is showing that phrase.
	ErrNoSender = errors.New("pairing: no device is showing that phrase")
)

// How long one address gets to answer.
const dialTimeout = 4 * time.Second

// peer is a shower as the scanner sees it.
type peer struct {
	mode    Mode
	session [16]byte
	k       []byte
	pub     [32]byte
	account [16]byte
	port    uint16
	addrs   []netip.Addr
}

// exchange sends req to p, sealed, and opens its answer.
func exchange(ctx context.Context, p peer, req request) (answer, error) {
	mine, err := newKeyPair()
	if err != nil {
		return answer{}, err
	}
	key, err := sealKey(p.k, mine.private, p.pub, p.session)
	if err != nil {
		return answer{}, err
	}
	t := transcript{mode: p.mode, session: p.session, account: p.account, s: p.pub, r: mine.public}
	plain, err := json.Marshal(req)
	if err != nil {
		return answer{}, err
	}
	sealed, err := seal(key, t.aad(dirRequest), plain)
	if err != nil {
		return answer{}, err
	}
	body := append(append(mine.public[:], proof(p.k, p.session, mine.public)...), sealed...)
	resp, err := post(ctx, p.addrs, p.port, "/pair/"+hex.EncodeToString(p.session[:]), body)
	if err != nil {
		return answer{}, err
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	_ = resp.Body.Close()
	if err != nil {
		return answer{}, fmt.Errorf("%w: %w", ErrUnreachable, err)
	}
	if resp.StatusCode != http.StatusOK {
		return answer{}, refusal(resp.StatusCode, data)
	}
	plainAns, err := open(key, t.aad(dirAnswer), data)
	if err != nil {
		return answer{}, err
	}
	var ans answer
	if err := json.Unmarshal(plainAns, &ans); err != nil {
		return answer{}, ErrOpen
	}
	return ans, nil
}

// refusal turns the shower's {"code"} into an error.
func refusal(status int, data []byte) error {
	var e errorBody
	_ = json.Unmarshal(data, &e)
	switch e.Code {
	case "used":
		return ErrUsed
	case "expired":
		return ErrExpired
	case "too_many_tries":
		return ErrTooManyTries
	case "wrong_account":
		return ErrWrongAccount
	case "bad_bundle":
		return ErrBadBundle
	case "refused":
		return ErrRefused
	}
	if status == http.StatusNotFound || status == http.StatusGone {
		return ErrUsed
	}
	return fmt.Errorf("%w: status %d", ErrRefused, status)
}

// post tries each address in turn until one connects.
func post(ctx context.Context, addrs []netip.Addr, port uint16, path string, body []byte) (*http.Response, error) {
	var last error
	for _, a := range addrs {
		dialer := &net.Dialer{Timeout: dialTimeout}
		client := &http.Client{
			Timeout: 20 * time.Second,
			Transport: &http.Transport{
				DialContext: dialer.DialContext, Proxy: nil, DisableKeepAlives: true,
				ResponseHeaderTimeout: 15 * time.Second,
			},
		}
		url := "http://" + netip.AddrPortFrom(a, port).String() + path
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/octet-stream")
		resp, err := client.Do(req)
		if err == nil {
			return resp, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		last = err
	}
	if last == nil {
		return nil, ErrUnreachable
	}
	return nil, fmt.Errorf("%w: %w", ErrUnreachable, last)
}

// LocalNetworkDenied reports whether err looks like iOS refusing the
// connection because Local Network access is off (an immediate "no route
// to host" to a private address).
func LocalNetworkDenied(err error) bool {
	return errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH)
}

// peerOf is the peer a scanned code names.
func peerOf(c Code) peer {
	return peer{mode: c.Mode, session: c.Session, k: c.Key[:], pub: c.Pub, account: c.Account, port: c.Port, addrs: c.Addrs}
}

// phrasePeer finds the Mac showing phrase on this network and runs CPace
// with it: one of its three tries.
func phrasePeer(ctx context.Context, phrase Phrase) (peer, error) {
	host, port, err := find(ctx, phrase.Tag)
	if err != nil {
		return peer{}, err
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return peer{}, fmt.Errorf("%w: %s doesn't resolve", ErrUnreachable, host)
	}
	var addrs []netip.Addr
	for _, ip := range ips {
		ip = ip.Unmap()
		if ip.IsPrivate() || ip.IsLinkLocalUnicast() {
			addrs = append(addrs, ip)
		}
	}
	if len(addrs) == 0 {
		return peer{}, ErrUnreachable
	}
	msgA, state, err := cpace.Start(phrase.Secret, phraseContext(phrase.Tag))
	if err != nil {
		return peer{}, err
	}
	resp, err := post(ctx, addrs, port, "/phrase/start", msgA)
	if err != nil {
		return peer{}, err
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = resp.Body.Close()
	if err != nil {
		return peer{}, fmt.Errorf("%w: %w", ErrUnreachable, err)
	}
	if resp.StatusCode != http.StatusOK {
		return peer{}, refusal(resp.StatusCode, data)
	}
	if len(data) < 16+32+16+1 {
		return peer{}, ErrRefused
	}
	p := peer{mode: ModeOffer, port: port, addrs: addrs}
	copy(p.session[:], data[:16])
	copy(p.pub[:], data[16:48])
	copy(p.account[:], data[48:64])
	key, err := state.Finish(data[64:])
	if err != nil {
		return peer{}, ErrRefused
	}
	p.k = phraseKey(key)
	return p, nil
}
