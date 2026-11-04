import { generateSealKeyPair } from './sealed'

// Prints a new key pair for sealed sign in sessions.
// The private key goes to the worker only. The public key goes to the web app and the worker.
const { publicKey, privateKey } = generateSealKeyPair()
console.log(`# Web app and worker
SESSION_PUBLIC_KEY=${publicKey}

# Worker only. Never give this to the web app. To change keys, put the new key first and keep the
# old one after a comma until every session has been used once (they are re-sealed on save).
WORKER_SESSION_PRIVATE_KEY=${privateKey}`)
