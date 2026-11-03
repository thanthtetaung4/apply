import { runMigrations } from './migrate'

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL (or DATABASE_URL_UNPOOLED for Neon) and try again.')
  process.exit(1)
}
runMigrations(url)
  .then(() => console.log('Migrations applied.'))
  .catch((err) => {
    console.error('Migration failed:', (err as Error).message)
    process.exit(1)
  })
