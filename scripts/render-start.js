const { spawn, spawnSync } = require('child_process')

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL no está definida. Configura la base PostgreSQL en Render antes de arrancar.')
  process.exit(1)
}

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || 'production',
  CDS_REQUIRES_DB_KIND: 'postgres',
  CDS_REQUIRES_DB_IMPL: '@cap-js/postgres',
  CDS_REQUIRES_DB_CREDENTIALS_URL: process.env.DATABASE_URL
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
