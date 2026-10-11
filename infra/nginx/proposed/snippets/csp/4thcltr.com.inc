# Declared: 4thcltr.com's repository nginx copy, never deployed. It names plausible.io,
# which the site may no longer load, and open.er-api.com, which it does (exchange rates,
# src/context/CurrencyContext.tsx). frame-ancestors moved to 'none'. MUST pass the
# injection check across the design recipes and locales before it is enabled; drop
# plausible.io if the check shows no request to it.
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; frame-src 'none'; img-src 'self' data:; font-src 'self' data: https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' https://plausible.io; connect-src 'self' https://api.web3forms.com https://plausible.io https://open.er-api.com; upgrade-insecure-requests" always;
