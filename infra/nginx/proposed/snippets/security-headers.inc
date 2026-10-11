# Headers every site sends. Included at server level AND inside any location that has
# its own add_header (nginx drops inherited add_headers there). See ../README.md.
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "DENY" always;
# TLS terminates at Cloudflare; the header still reaches the browser. No preload until
# it has been live a month without incident.
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
