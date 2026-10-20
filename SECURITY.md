# Security

This project is a development chat application. It has not had an independent security audit and does not provide end-to-end encryption.

## Current protections

- Salted scrypt password hashes and HttpOnly/SameSite session cookies.
- Session expiry and logout revocation.
- Membership checks for history, messages and uploaded attachments.
- Text-node rendering, Content Security Policy and upload signature checks.
- Basic sign-in, message, upload and chat-creation limits.

## Before a public deployment

Use HTTPS and set production cookie settings correctly. Keep the database and uploads private. Add registration/abuse policies, storage quotas, backups, retention rules and monitoring. Review the complete threat model and the deployment's reverse-proxy configuration.

The server operator can read stored messages and media. Basic rate limits live in one process and are not a distributed abuse-protection system. There is no password-reset service or recovery flow.

## Reporting a problem

Do not post passwords, session tokens, private messages or live database files in an issue. For a security bug, provide a minimal reproduction using test accounts and explain the impact. If reporting publicly would expose an active vulnerability, contact the repository maintainer privately before sharing exploit details.
