# Audio Files — Nexus Chat

Place these two files in the ROOT of the project (same folder as index.html):

| File           | Used for                        | Requirement              |
|----------------|---------------------------------|--------------------------|
| `message.mp3`  | Incoming message notification   | Short ~0.5s chime        |
| `ringtone.mp3` | Incoming call (loops until answered/rejected) | 3–5s ringtone loop |

## Free sources

- **message.mp3** — https://mixkit.co/free-sound-effects/notification/
- **ringtone.mp3** — https://mixkit.co/free-sound-effects/phone/

## Notes

- The app loads these lazily (only when first needed) — no cost if never triggered
- `message.mp3` will NOT play for your own messages (checked by senderId)
- `ringtone.mp3` loops automatically via `Audio.loop = true`
- Both are silently ignored if the files are missing (`.catch(() => {})`)
