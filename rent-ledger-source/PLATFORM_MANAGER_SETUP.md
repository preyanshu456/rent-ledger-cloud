# Platform-manager console

The cross-owner console is served at `/platform-admin.html`. Any authenticated
account with the owner or manager role can view and modify records across all
owner organizations. Tenant accounts are explicitly denied access. All owners
and managers can therefore see tenant contact and billing information across
the service, not just their own organization's records.

The console provides tenant creation, tenant move-out, and electricity bills.
Move-out retains rent/electricity history and clears tenant login, contact, and
ID-number data. Bills are recorded as due; they do not confirm or verify a
payment. Opening an owner's records and making changes are recorded in that
organization's audit log with the acting account's identity. The owner-directory
list itself is recorded as a platform-level audit event.
