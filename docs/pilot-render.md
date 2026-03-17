# Piloto rápido en Render

Esta opción es la más rápida para poner el proyecto en línea sin montar un VPS manualmente.

## Qué se despliega realmente

En este proyecto no hace falta separar frontend y backend en Render porque las pantallas estáticas ya se sirven desde el propio backend CAP/Express:

- `app/index.html`
- `app/products/index.html`
- `app/campaigns/index.html`
- `app/clients/index.html`

Por eso, en Render basta con:

1. Un `Web Service` Node.js
2. Una base de datos PostgreSQL

## Archivos preparados en el repo

- [render.yaml](../render.yaml): blueprint para Render
- [scripts/render-start.js](../scripts/render-start.js): arranque con migración a PostgreSQL antes de servir la app

## Flujo recomendado

### 1. Subir el proyecto a GitHub

El repositorio debe ser accesible desde Render.

### 2. Crear el servicio en Render

Puedes hacerlo de dos formas:

- Opción A: `New + Blueprint` y seleccionar el repo. Render leerá [render.yaml](../render.yaml).
- Opción B: crear manualmente un `PostgreSQL` y un `Web Service` usando los mismos comandos del blueprint.

## Configuración esperada en Render

### Base de datos

- Tipo: PostgreSQL
- Plan: Free
- Duración gratis habitual: 90 días

### Web Service

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm run start:render`
- Health Check Path: `/backoffice/session`

## Qué hace `start:render`

El script [scripts/render-start.js](../scripts/render-start.js):

1. Comprueba que existe `DATABASE_URL`
2. Fuerza CAP a usar PostgreSQL
3. Ejecuta `cds deploy`
4. Arranca `cds serve`
5. Fuerza autenticación interna del backoffice para no depender de XSUAA en este piloto

Así puedes seguir usando SQLite localmente y PostgreSQL en Render sin tocar el flujo local.

## Variables importantes

Render debe proporcionar:

- `DATABASE_URL`
- `NODE_ENV=production`
- `BACKOFFICE_SESSION_SECRET`

Si quieres varios usuarios, añade también `BACKOFFICE_USERS_JSON` con un JSON como este:

```json
[
	{
		"username": "daniel",
		"password": "TuClaveSegura123!",
		"displayName": "Daniel",
		"role": "admin"
	},
	{
		"username": "maria",
		"password": "OtraClaveSegura123!",
		"displayName": "Maria Comercial",
		"role": "commercial"
	}
]
```

Si solo quieres una cuenta inicial, también puedes usar:

- `BACKOFFICE_ADMIN_USER`
- `BACKOFFICE_ADMIN_PASSWORD`
- `BACKOFFICE_ADMIN_NAME`
- `BACKOFFICE_ADMIN_ROLE`

## Consideraciones del piloto

- El plan gratis puede quedarse dormido si no recibe tráfico
- El primer acceso tras inactividad puede tardar unos segundos
- Las imágenes subidas por usuarios no deberían quedarse en disco local a largo plazo en un PaaS; para un piloto corto puede valer, pero para algo más serio conviene moverlas a almacenamiento externo tipo S3 o Cloudinary

## Recomendación para este piloto de 1 mes

Render es válido si quieres arrancar muy rápido, pero antes de abrirlo al cliente conviene:

1. Hacer una carga inicial de productos real
2. Probar exportaciones PDF y Excel
3. Verificar subida de imágenes
4. Confirmar que PostgreSQL contiene el esquema correcto
5. Dejar claro que es un piloto, no aún producción final
