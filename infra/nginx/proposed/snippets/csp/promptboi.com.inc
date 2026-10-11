# Verified 2026-10-11 in chromium, firefox and webkit over the real e2e flows with the
# header injected: zero violations. Source of truth: promptboi.com security/csp-policy.txt
# (the inline hash is vite's preloadError handler; the repo's build checks it).
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'sha256-WAGjBX2V2N3buc/r6yknFrz5pIsjHIG2eXqEyMFAe6s='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://api.dicebear.com; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' https://hn.algolia.com https://dev.to https://mastodon.social https://hachyderm.io; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests" always;
