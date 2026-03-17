const { spawn, spawnSync } = require('child_process')

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL no está definida. Configura la base PostgreSQL en Render antes de arrancar.')
  process.exit(1)
}

let databaseUrl

try {
  databaseUrl = new URL(process.env.DATABASE_URL)
} catch {
  console.error('DATABASE_URL no tiene un formato de URL PostgreSQL válido.')
  process.exit(1)
}

const databaseName = databaseUrl.pathname.replace(/^\//, '')

if (!databaseUrl.hostname || !databaseName || !databaseUrl.username) {
  console.error('DATABASE_URL está incompleta. Debe incluir host, base de datos, usuario y contraseña.')
  process.exit(1)
}

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || 'production',
  CDS_REQUIRES_DB_KIND: 'postgres',
  CDS_REQUIRES_DB_IMPL: '@cap-js/postgres',
  CDS_REQUIRES_DB_CREDENTIALS_HOST: databaseUrl.hostname,
  CDS_REQUIRES_DB_CREDENTIALS_PORT: databaseUrl.port || '5432',
  CDS_REQUIRES_DB_CREDENTIALS_DATABASE: databaseName,
  CDS_REQUIRES_DB_CREDENTIALS_USER: decodeURIComponent(databaseUrl.username),
  CDS_REQUIRES_DB_CREDENTIALS_PASSWORD: decodeURIComponent(databaseUrl.password)
}

const deploy = spawnSync(executable, ['cds', 'deploy'], {
  env,
  stdio: 'inherit'
})

if (deploy.status !== 0) {
  process.exit(deploy.status || 1)
}

const serve = spawn(executable, ['cds', 'serve'], {
  env,
  stdio: 'inherit'
})

serve.on('exit', code => {
  process.exit(code || 0)
})
