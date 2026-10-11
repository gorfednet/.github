# Declared: gorfmusic.com's repository nginx copy, never deployed. frame-ancestors moved
# from 'self' to 'none' to match X-Frame-Options DENY (nothing frames the site). Enable
# after the injection check.
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; frame-src 'none'; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self'; connect-src 'self' https://api.web3forms.com; upgrade-insecure-requests" always;
