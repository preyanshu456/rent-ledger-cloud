# Platform-manager console

The cross-owner console is served at `/platform-admin.html`, but its APIs are
disabled unless `PLATFORM_ADMIN_CONTACTS` or the legacy
`PLATFORM_ADMIN_CONTACT` is set on the server. Set `PLATFORM_ADMIN_CONTACTS`
to up to two comma-separated login contacts (phone numbers or emails) for
separate designated accounts; the app normalizes them the same way as sign-in.
Do not put passwords here. Keep both variables blank to leave global access
disabled. Each designated account must already exist, be active, have the owner
or manager role, and sign in with its own password. The older singular variable
continues to allow one account. If more than two contacts are provided, extras
are ignored and a startup warning is emitted.

The console provides tenant creation, tenant move-out, and electricity bills.
Move-out retains rent/electricity history and clears tenant login, contact, and
ID-number data. Bills are recorded as due; they do not confirm or verify a
payment. Opening an owner's records and making changes are recorded in that
organization's audit log with the acting account's identity, so the two
designated accounts remain distinguishable. The owner-directory list itself is
recorded as a platform-level audit event.
