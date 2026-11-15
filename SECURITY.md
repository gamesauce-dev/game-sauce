# Security policy

game-sauce is a self-hosted library for a household. It has accounts, sessions, backups that contain
password hashes, and a server that reads folders on your machine, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it privately in one of these ways:

1. **GitHub:** on the repository's **Security** tab, choose **Report a vulnerability**. Only the maintainer
   can see what you write there.
2. **Email:** [hello@gamesauce.app](mailto:hello@gamesauce.app) with the subject line "game-sauce security".

Please include what you found, the version (**Settings, My account** shows it at the bottom), how to
reproduce it, and what an attacker could do with it. A screenshot or a short description is plenty. Do not
send real passwords, keys, ROMs or personal data.

This is a small project run by one person, so replies are best effort: I aim to acknowledge a report
within a week, and to fix a confirmed problem in a release as soon as I reasonably can. If you would like to
be credited in the release notes, say so; if you would rather stay anonymous, that is fine too.

## Which versions get fixes

Only the **latest release**. Please update before reporting, in case the problem is already fixed
(**Settings, System health** shows the version, and the releases page lists what changed).

## What is in scope

- Getting into an account, or doing something an account is not allowed to do (a member acting as an
  admin, a play-only account downloading ROM files, reading someone else's messages or saves).
- Reading, changing or deleting files outside the folders the server is meant to use, or leaking the
  secret key, a password hash or a provider credential.
- Bypassing the sign-in, session, lockout or request-origin checks.
- Cross-site scripting or request forgery in the app or the website.
- Problems in how backups or restores are created, checked or applied.

## What is not in scope

- Running the server open on the internet without HTTPS and a VPN or reverse proxy, against the advice in
  the [deployment guide](docs/DEPLOYMENT.md#6-security-checklist-do-before-exposing-beyond-your-lan).
  The app is built for your own network.
- Someone who already has the admin password, or full access to the machine or the data folder.
- Problems in the emulators, in EmulatorJS, or in the metadata providers: please report those to their own
  projects (game-sauce will pass the news on if it affects its users).
- Anything about getting or sharing ROMs or BIOS files. game-sauce does not supply or search for them.

## Keeping your own server safe

- Keep it on your home network, or reach it through a VPN such as WireGuard or Tailscale.
- If it must be reachable from outside, put it behind HTTPS and set `GAMESAUCE_COOKIE_SECURE=1`.
- Use a strong admin password, change the first one, and give only people you trust an account.
- Keep backups somewhere safe: a backup holds everything the database does.
- Update when a release is published.

Thank you for helping keep game-sauce safe.
