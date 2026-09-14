# Fix recommendations for the 24 failing cases

This is a post-evaluation review of the frozen candidate, SHA-256
`f7dd485b65c01e3f0984636484771fcaa80831e6fdaa77d346d587015817ed25`
for `candidate/gron.py`. The recommendations below have not been implemented or
tested. The measured result remains **200/224 passed (89.29%)**.

The observed failures are compatibility gaps in the generated CLI. ECorp reached
accepted completion, exported source, and the official evaluator executed all
224 eligible cases. These findings do not establish defects in ECorp's scheduler
or tenant isolation. The exact failed assertions are retained in
[failure-analysis.json](failure-analysis.json) and the official evaluator record.

## Repair map

| Repair area | Eligible failures | Main source location |
| --- | ---: | --- |
| ANSI rendering and color selection | 4 | [emit_statements](candidate/gron.py#L317), [ungron](candidate/gron.py#L489), [parse_flags](candidate/gron.py#L526) |
| Statement classification and diagnostics | 7 | [parse_statement](candidate/gron.py#L329), [values](candidate/gron.py#L505) |
| Invocation-selected ungron mode | 1 | [main](candidate/gron.py#L604) |
| Proxy selection and bypass | 4 | [fetch](candidate/gron.py#L565) |
| URL normalization | 3 | [read_input](candidate/gron.py#L586), [request construction](candidate/gron.py#L576) |
| Request deadline | 1 | [opener.open](candidate/gron.py#L578) |
| Network/proxy error formatting | 4 | [exception handling](candidate/gron.py#L580) |
| **Total** | **24** | |

## 1. Implement actual color rendering

`emit_statements` prints plain text and has no color option or ANSI renderer.
`ungron` uses `colorize` only to select compact versus pretty JSON. Flag parsing
defaults color to false and the program never checks whether stdout is a TTY.

Add a shared color-selection policy and actual renderers for gron statements and
ungron JSON. The recorded reference behavior requires explicit `-c` to enable
color even when `-m` is also present, in either argument order. With neither
override, use stdout's TTY status. Match the reference's formatting and token
colors, reset sequences and compact colored JSON while preserving current
plain-text output when color is disabled.

Regression coverage should include redirected output, a PTY, `-c`, `-m`, both
flag orders, boolean flag values, and ungron JSON. Two failed official cases
exercise automatic PTY color without `-c`; implementing the flag alone is insufficient.

## 2. Separate ignored input from malformed statements

The parser currently rejects grep's `--` separators and some non-assignment prose.
It also loses specific key/value error categories. Make narrow changes:

- Classify the reference's ignored lines before parsing an assignment. Skip
  grep separators and non-statement prose such as `this is not a valid statement`
  and `also invalid = malformed` without discarding malformed assignments.
  Preserve valid non-`json` roots such as `foo = 1;`.
- Preserve the invalid quoted-key token and its diagnostic category at
  [lines 359–364](candidate/gron.py#L359), instead of collapsing every decoder
  error to a generic invalid statement. The failing `json["invalid\xff"] = 1;`
  input requires an `invalid quoted key` diagnostic and exit code 5; missing
  brackets remain a separate syntax error.
- Distinguish an isolated malformed container token such as `json.likes = [;`
  from a nonempty container literal. The former needs the complete statement
  and invalid-value diagnostic. Keep the reference behavior for
  `json.a = [1,2];`, which reports that the statement has no value in ungron mode.
- In `values`, handle the specifically failing newline-only input before the
  early no-`=` skip at [lines 507–508](candidate/gron.py#L507). Do not make the
  entire values parser strict: recorded reference interactions accept missing
  semicolons, ignore `BAD` between valid values, and ignore nonempty container
  values. Empty stdin must succeed; the encountered blank line in newline-only
  input must produce exit code 5 and `failed to parse`.

Add exact stdout/stderr/exit-code cases for both grep-separator fixtures,
mixed prose and assignments, bad quoted keys, malformed scalar/container values,
newline-only values input and the existing permissive values behaviors. Avoid
catching every parser exception and continuing: that would hide real input errors.

## 3. Recognize invocation through an ungron symlink

`main` reads `sys.argv[1:]` and never uses the invoked program name. Initialize
the operation mode from the basename of `sys.argv[0]`, with reference-compatible
explicit flag overrides, so a symlink named `ungron` selects reversal mode. Check
the invocation name before resolving the symlink to its target.

Test the ordinary executable, an `ungron` symlink, an unrelated symlink name and
explicit `--ungron` boolean overrides. The copied Python launcher does not need
to delegate to the reference program.

## 4. Resolve proxy configuration and bypass entries correctly

`fetch` reads only the CLI proxy. `ProxyHandler({})` explicitly disables the
environment-proxy fallback. Resolve an explicit CLI proxy first, then the
appropriate environment proxy, with reference-compatible bypass precedence.

The code derives only `.hostname`, discarding the URL port. All three failing
`--noproxy` fixtures contain a port, including a leading-dot suffix such as
`.0.1:PORT`. Match normalized entries against hostname and the applicable port;
retain comma-separated lists, whitespace handling and leading-dot suffixes.

Use a logging proxy to prove actual proxy use, CLI-over-environment precedence,
bypass and non-bypass for a different port. A successful direct request alone
does not establish correct environment-proxy support: the currently passing
`no_proxy` environment case can pass while all environment proxies are disabled.

## 5. Normalize URL components before transport

`read_input` uses a case-sensitive prefix check, so uppercase `HTTP://` is treated
as a filename. Parse the URL and normalize its scheme without lowercasing the
path or query.

`Request` receives the original URL unchanged. Reconstruct the transport
authority from hostname and port, handle userinfo separately, and UTF-8
percent-encode non-ASCII path/query components while retaining existing escapes,
query separators, plus signs and duplicate parameters. Verify authentication
behavior explicitly: the existing userinfo fixture proves successful URL
handling, not authentication-header correctness.

Add local-server cases for uppercase schemes, userinfo, Unicode paths/queries,
already escaped input and duplicate query parameters. The raw uppercase-HTTPS
failure is officially excluded and is not an additional eligible failure.

## 6. Match the request deadline

The candidate uses 30 seconds; the failing fixture delays response headers for
25 seconds and expects the reference's 20-second timeout, exit code 4 and deadline
diagnostic. Introduce a named 20-second request budget and map expiry accordingly.

Verify delayed headers, slow bodies and redirects separately. A per-socket
timeout does not guarantee a total deadline across redirects and body reads.

## 7. Format network errors by category

The exception handler exposes Python exception strings. Introduce typed
compatibility formatting for DNS lookup, connection refusal, certificate
verification and proxy connection errors while retaining exit code 4. Observed
assertions distinguish `dial tcp:`, lowercase `connection refused`, and
`tls: failed to verify certificate`.

Parse proxy authority explicitly. Passing a malformed proxy such as
`not-a-valid-url` directly to urllib treats it as a hostname, producing a different
failure category from the reference. Reproduce the reference's missing-host
semantics for that class of input rather than special-casing the fixture string.

Certificate verification already rejects the self-signed certificate. Preserve
that rejection and correct the diagnostic. Also preserve the existing behavior
that reads HTTP error response bodies at [lines 580–581](candidate/gron.py#L580).

## Implementation order and verification

1. Implement the renderer, invocation mode and narrow parser repairs as separate
   changes with focused differential cases against the permitted reference CLI.
2. Repair URL/proxy/deadline handling and add controlled local HTTP/proxy servers
   that assert routing, headers, timing, exit status and diagnostics.
3. Retain the previously passing self-authored cases and run the complete official
   eligible suite against a newly frozen candidate. Record its new source hash,
   spend, lineage and results alongside this baseline.

For future ECorp missions, declare a compatibility matrix covering modes, flag
combinations, TTY behavior, invocation names, malformed inputs and network
configuration before implementation. Require evidence for those categories in
the prospective task verifier. A large number of self-authored passing tests
does not compensate for an untested category, and artifact/file checks alone do
not prove CLI compatibility.

A repair based on these published failures is a test-informed follow-up. Its
score must be reported separately; it does not replace this original result.
