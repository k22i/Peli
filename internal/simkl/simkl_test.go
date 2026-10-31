package simkl

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestErrors(t *testing.T) {
	for _, tc := range []struct {
		status int
		header string
		body   string
		check  func(error) bool
	}{
		{400, "", `{"error":"authorization_pending"}`, func(err error) bool { return errors.Is(err, ErrPending) }},
		{400, "", `{"error":"slow_down"}`, func(err error) bool { return errors.Is(err, ErrSlowDown) }},
		{400, "", `{"error":"expired_token"}`, func(err error) bool { return errors.Is(err, ErrCodeGone) }},
		{400, "", `{"error":"invalid_grant"}`, func(err error) bool { return errors.Is(err, ErrUnauthorized) }},
		{401, "", `{"error":"user_token_failed"}`, func(err error) bool { return errors.Is(err, ErrUnauthorized) }},
		{404, "", `{"error":"id_err"}`, func(err error) bool { return errors.Is(err, ErrNotFound) }},
		{409, "", `{"watched_at":"x"}`, func(err error) bool { return errors.Is(err, ErrAlreadyDone) }},
		{503, "", ``, func(err error) bool { return errors.Is(err, ErrUnavailable) && Temporary(err) }},
		// The per-second limit clears at once, whatever Retry-After says;
		// the daily one lasts until it says.
		{429, "45000", `{"error":"rate_limit"}`, func(err error) bool {
			var limited *RateLimited
			return errors.As(err, &limited) && limited.RetryAfter == 0
		}},
		{429, "45000", `{"error":"user_limit_exceeded"}`, func(err error) bool {
			var limited *RateLimited
			return errors.As(err, &limited) && limited.RetryAfter == 45000*time.Second
		}},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if tc.header != "" {
				w.Header().Set("Retry-After", tc.header)
			}
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		_, err := New(srv.URL, "id", "1.0").Scrobble(context.Background(), "token", ActionStop, Item{}, 50, 90)
		srv.Close()
		if !tc.check(err) {
			t.Errorf("HTTP %d %s: err = %v", tc.status, tc.body, err)
		}
	}
}

func TestNoClientID(t *testing.T) {
	if _, err := New(DefaultURL, "", "1.0").StartDevice(context.Background()); !errors.Is(err, ErrNoClientID) {
		t.Fatalf("err = %v", err)
	}
}

func TestProgressIsRounded(t *testing.T) {
	for in, want := range map[float64]float64{12.3456: 12.35, -3: 0, 140: 100} {
		if got := roundProgress(in); got != want {
			t.Errorf("roundProgress(%v) = %v", in, got)
		}
	}
}
