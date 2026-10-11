# promptboi.com has a voice search (src/app/hooks/useVoiceSearch.ts); the microphone is
# allowed for the site itself only.
add_header Permissions-Policy "camera=(), microphone=(self), geolocation=(), payment=(), usb=()" always;
