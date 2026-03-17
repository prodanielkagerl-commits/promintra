module.exports = {
  apps: [
    {
      name: 'berlingerhaus-backoffice',
      cwd: '/opt/berlingerhaus',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production',
        PORT: '4004'
      }
    }
  ]
}
