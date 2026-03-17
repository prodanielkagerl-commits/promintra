const express = require('express')
const ExcelJS = require('exceljs')
const fs = require('fs')
const multer = require('multer')
const path = require('path')
const PDFDocument = require('pdfkit')
const crypto = require('crypto')
const cds = require('@sap/cds')

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql
const MAX_PRODUCT_IMAGES = 4
const ALLOWED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg']
const USER_SESSION_COOKIE = 'bh_session'
const USER_ROLE_COOKIE = 'bh_role'
const SESSION_TTL_SECONDS = 60 * 60 * 12
const SESSION_SECRET = process.env.BACKOFFICE_SESSION_SECRET || 'berlingerhaus-dev-session-secret'
const USER_ROLES = {
  admin: {
    label: 'Administrador',
    permissions: {
      dashboard: true,
      products: { read: true, write: true, delete: true, export: true },
      campaigns: { read: true, write: true, delete: true, export: true },
      clients: { read: true, write: true, delete: true }
    }
  },
  commercial: {
    label: 'Comercial',
    permissions: {
      dashboard: true,
      products: { read: true, write: false, delete: false, export: true },
      campaigns: { read: true, write: true, delete: false, export: true },
      clients: { read: true, write: true, delete: false }
    }
  },
  readonly: {
    label: 'Solo lectura',
    permissions: {
      dashboard: true,
      products: { read: true, write: false, delete: false, export: true },
      campaigns: { read: true, write: false, delete: false, export: true },
      clients: { read: true, write: false, delete: false }
    }
  }
}

const DEMO_BACKOFFICE_USERS = [
  { username: 'admin', password: 'Admin123!', displayName: 'Administrador', role: 'admin' },
  { username: 'comercial', password: 'Comercial123!', displayName: 'Equipo comercial', role: 'commercial' },
  { username: 'lectura', password: 'Lectura123!', displayName: 'Consulta', role: 'readonly' },
  { username: 'marc', password: '48295173', displayName: 'Marc', role: 'commercial' },
  { username: 'rodrigo', password: '59318462', displayName: 'Rodrigo', role: 'commercial' }
]

const normalizeDecimal = value => value === '' || value === null || value === undefined ? null : Number(value)
const normalizeInteger = value => value === '' || value === null || value === undefined ? 0 : Number.parseInt(value, 10)

const sanitizeProductPayload = body => {
  const payload = {}

  if ('code' in body) payload.code = String(body.code || '').trim()
  if ('name' in body) payload.name = String(body.name || '').trim()
  if ('type' in body) payload.type = String(body.type || '').trim()
  if ('image' in body) payload.image = String(body.image || '').trim() || null
  if ('weight' in body) payload.weight = normalizeDecimal(body.weight)
  if ('grossPrice' in body) payload.grossPrice = normalizeDecimal(body.grossPrice)
  if ('netPrice' in body) payload.netPrice = normalizeDecimal(body.netPrice)
  if ('stock' in body) payload.stock = normalizeInteger(body.stock)

  return payload
}

const sanitizeCampaignPayload = body => {
  const payload = {}

  if ('name' in body) payload.name = String(body.name || '').trim()
  if ('description' in body) payload.description = String(body.description || '').trim() || null
  if ('startDate' in body) payload.startDate = String(body.startDate || '').trim() || null
  if ('endDate' in body) payload.endDate = String(body.endDate || '').trim() || null
  if ('clientId' in body) payload.client_ID = String(body.clientId || '').trim() || null

  return payload
}

const sanitizeClientPayload = body => {
  const payload = {}

  if ('code' in body) payload.code = String(body.code || '').trim()
  if ('name' in body) payload.name = String(body.name || '').trim()
  if ('contactName' in body) payload.contactName = String(body.contactName || '').trim() || null
  if ('email' in body) payload.email = String(body.email || '').trim() || null
  if ('phone' in body) payload.phone = String(body.phone || '').trim() || null
  if ('city' in body) payload.city = String(body.city || '').trim() || null
  if ('country' in body) payload.country = String(body.country || '').trim() || null

  return payload
}

const normalizeProductIds = value => {
  if (!value) return []

  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value]

  return [...new Set(items.map(item => String(item).trim()).filter(Boolean))]
}

const todayIsoDate = () => new Date().toISOString().slice(0, 10)

const normalizeRole = role => USER_ROLES[role] ? role : 'admin'

const normalizeBackofficeUser = user => {
  const username = String(user?.username || user?.user || '').trim()
  const password = String(user?.password || '').trim()
  if (!username || !password) return null

  return {
    username,
    password,
    displayName: String(user?.displayName || user?.name || username).trim() || username,
    role: normalizeRole(user?.role)
  }
}

const loadConfiguredUsers = () => {
  const fromJson = String(process.env.BACKOFFICE_USERS_JSON || '').trim()
  if (fromJson) {
    try {
      const parsed = JSON.parse(fromJson)
      const candidates = Array.isArray(parsed)
        ? parsed
        : Object.entries(parsed).map(([username, config]) => ({
            username,
            ...(typeof config === 'string' ? { password: config } : config)
          }))

      const users = candidates.map(normalizeBackofficeUser).filter(Boolean)
      if (users.length) return users
    } catch (error) {
      console.warn('BACKOFFICE_USERS_JSON no se pudo interpretar. Se usarán usuarios demo.', error.message)
    }
  }

  const adminUser = String(process.env.BACKOFFICE_ADMIN_USER || '').trim()
  const adminPassword = String(process.env.BACKOFFICE_ADMIN_PASSWORD || '').trim()
  if (adminUser && adminPassword) {
    return [normalizeBackofficeUser({
      username: adminUser,
      password: adminPassword,
      displayName: process.env.BACKOFFICE_ADMIN_NAME || adminUser,
      role: process.env.BACKOFFICE_ADMIN_ROLE || 'admin'
    })].filter(Boolean)
  }

  console.warn('No hay usuarios de backoffice configurados. Se usarán credenciales demo hasta que definas BACKOFFICE_USERS_JSON o BACKOFFICE_ADMIN_USER/BACKOFFICE_ADMIN_PASSWORD.')
  return DEMO_BACKOFFICE_USERS.map(normalizeBackofficeUser).filter(Boolean)
}

const BACKOFFICE_USERS = new Map(
  loadConfiguredUsers().map(user => [user.username.toLowerCase(), user])
)

const parseCookies = cookieHeader => {
  if (!cookieHeader) return {}

  return cookieHeader
    .split(';')
    .map(cookie => cookie.trim())
    .filter(Boolean)
    .reduce((all, cookie) => {
      const separatorIndex = cookie.indexOf('=')
      if (separatorIndex < 0) return all

      const key = cookie.slice(0, separatorIndex).trim()
      const value = cookie.slice(separatorIndex + 1).trim()
      all[key] = decodeURIComponent(value)
      return all
    }, {})
}

const buildUserSession = user => {
  if (!user) {
    return {
      isAuthenticated: false,
      username: null,
      displayName: null,
      role: null,
      label: 'Sin sesión',
      permissions: {}
    }
  }

  const normalizedRole = normalizeRole(user.role)
  const roleConfig = USER_ROLES[normalizedRole]

  return {
    isAuthenticated: true,
    username: user.username,
    displayName: user.displayName,
    role: normalizedRole,
    label: roleConfig.label,
    permissions: roleConfig.permissions
  }
}

const buildCookie = (name, value, maxAge) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`
}

const createSessionToken = username => {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
  })).toString('base64url')

  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url')

  return `${payload}.${signature}`
}

const readSessionToken = token => {
  if (!token) return null

  const [payload, signature] = String(token).split('.')
  if (!payload || !signature) return null

  const expectedSignature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url')

  const providedBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expectedSignature)
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!parsed?.username || !parsed?.expiresAt || parsed.expiresAt < Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

const setSessionCookie = (res, username) => {
  res.setHeader('Set-Cookie', [
    buildCookie(USER_SESSION_COOKIE, createSessionToken(username), SESSION_TTL_SECONDS),
    buildCookie(USER_ROLE_COOKIE, '', 0)
  ])
}

const clearSessionCookie = res => {
  res.setHeader('Set-Cookie', [
    buildCookie(USER_SESSION_COOKIE, '', 0),
    buildCookie(USER_ROLE_COOKIE, '', 0)
  ])
}

const findBackofficeUser = username => BACKOFFICE_USERS.get(String(username || '').trim().toLowerCase()) || null

const passwordsMatch = (providedPassword, expectedPassword) => {
  const providedBuffer = Buffer.from(String(providedPassword || ''))
  const expectedBuffer = Buffer.from(String(expectedPassword || ''))
  if (providedBuffer.length !== expectedBuffer.length) return false
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer)
}

const authenticateBackofficeUser = (username, password) => {
  const user = findBackofficeUser(username)
  if (!user || !passwordsMatch(password, user.password)) return null
  return user
}

const requireAuthenticatedApi = (req, res, next) => {
  if (req.currentUser) return next()
  return res.status(401).json({ message: 'Debes iniciar sesión para acceder al backoffice.' })
}

const authorizeModuleAccess = (moduleName, accessLevel) => (req, res, next) => {
  const allowed = moduleName === 'dashboard'
    ? Boolean(req.userSession?.permissions?.dashboard)
    : Boolean(req.userSession?.permissions?.[moduleName]?.[accessLevel])

  if (allowed) return next()

  const moduleLabels = {
    products: 'productos',
    campaigns: 'campañas',
    clients: 'clientes',
    dashboard: 'dashboard'
  }

  const actionLabel = accessLevel === 'delete'
    ? 'eliminar'
    : accessLevel === 'write'
      ? 'modificar'
      : 'consultar'

  return res.status(403).json({
    message: `Tu perfil no tiene permisos para ${actionLabel} ${moduleLabels[moduleName] || 'este módulo'}.`
  })
}

const buildDashboardData = async (db, Products, Campaigns, Clients) => {
  const [products, campaigns, clients] = await Promise.all([
    db.run(
      SELECT.from(Products)
        .columns('ID', 'code', 'name', 'type', 'image', 'stock')
        .orderBy('name')
    ),
    db.run(
      SELECT.from(Campaigns)
        .columns('ID', 'name', 'startDate', 'endDate', 'client_ID')
        .orderBy('startDate desc', 'name')
    ),
    db.run(
      SELECT.from(Clients)
        .columns('ID', 'code', 'name')
        .orderBy('name')
    )
  ])

  const today = todayIsoDate()
  const inactivityCutoff = new Date()
  inactivityCutoff.setDate(inactivityCutoff.getDate() - 90)
  const inactivityCutoffIso = inactivityCutoff.toISOString().slice(0, 10)
  const clientsById = new Map(clients.map(client => [client.ID, client]))

  const activeCampaigns = campaigns.filter(campaign => {
    if (!campaign.startDate && !campaign.endDate) return false
    const startsOk = !campaign.startDate || campaign.startDate <= today
    const endsOk = !campaign.endDate || campaign.endDate >= today
    return startsOk && endsOk
  })

  const upcomingCampaigns = campaigns.filter(campaign => campaign.startDate && campaign.startDate > today)
  const outOfStockProducts = products.filter(product => Number(product.stock ?? 0) <= 0)
  const productsWithoutImage = products.filter(product => !String(product.image || '').trim())
  const inactiveClients = clients.filter(client => {
    const clientCampaigns = campaigns.filter(campaign => campaign.client_ID === client.ID)
    if (!clientCampaigns.length) return true

    const lastActivity = clientCampaigns.reduce((latest, campaign) => {
      const current = campaign.endDate || campaign.startDate || ''
      return current > latest ? current : latest
    }, '')

    return !lastActivity || lastActivity < inactivityCutoffIso
  })

  return {
    kpis: {
      activeCampaigns: activeCampaigns.length,
      upcomingCampaigns: upcomingCampaigns.length,
      outOfStockProducts: outOfStockProducts.length,
      productsWithoutImage: productsWithoutImage.length,
      inactiveClients: inactiveClients.length
    },
    highlights: {
      activeCampaigns: activeCampaigns.slice(0, 5).map(campaign => ({
        ID: campaign.ID,
        name: campaign.name,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        clientName: clientsById.get(campaign.client_ID)?.name || 'Sin cliente asignado'
      })),
      upcomingCampaigns: upcomingCampaigns.slice(0, 5).map(campaign => ({
        ID: campaign.ID,
        name: campaign.name,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        clientName: clientsById.get(campaign.client_ID)?.name || 'Sin cliente asignado'
      })),
      outOfStockProducts: outOfStockProducts.slice(0, 5).map(product => ({
        ID: product.ID,
        code: product.code,
        name: product.name,
        stock: product.stock ?? 0
      })),
      productsWithoutImage: productsWithoutImage.slice(0, 5).map(product => ({
        ID: product.ID,
        code: product.code,
        name: product.name,
        type: product.type
      })),
      inactiveClients: inactiveClients.slice(0, 5).map(client => {
        const clientCampaigns = campaigns.filter(campaign => campaign.client_ID === client.ID)
        const lastActivity = clientCampaigns.reduce((latest, campaign) => {
          const current = campaign.endDate || campaign.startDate || ''
          return current > latest ? current : latest
        }, '')

        return {
          ID: client.ID,
          code: client.code,
          name: client.name,
          lastActivity: lastActivity || null
        }
      })
    }
  }
}

const syncCampaignProducts = async (db, ProductCampaigns, campaignId, productIds) => {
  await db.run(DELETE.from(ProductCampaigns).where({ campaign_ID: campaignId }))

  if (!productIds.length) return

  await db.run(
    INSERT.into(ProductCampaigns).entries(
      productIds.map(productId => ({ campaign_ID: campaignId, product_ID: productId }))
    )
  )
}

const removeFileIfExists = filePath => {
  if (!filePath) return

  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    // ignore cleanup errors
  }
}

const isManagedProductUpload = (productId, imagePath) => {
  if (!productId || !imagePath) return false
  return path.basename(imagePath).startsWith(`${productId}-`)
}

const sortProductImages = images => [...images].sort((left, right) => {
  if ((left.sortOrder ?? 0) !== (right.sortOrder ?? 0)) {
    return (left.sortOrder ?? 0) - (right.sortOrder ?? 0)
  }

  if (left.createdAt && right.createdAt && left.createdAt !== right.createdAt) {
    return String(left.createdAt).localeCompare(String(right.createdAt))
  }

  return String(left.ID).localeCompare(String(right.ID))
})

const loadProductImages = async (db, ProductImages, productId) => {
  return db.run(
    SELECT.from(ProductImages)
      .columns('ID', 'product_ID', 'imageUrl', 'isCover', 'sortOrder', 'createdAt')
      .where({ product_ID: productId })
      .orderBy('sortOrder', 'createdAt', 'ID')
  )
}

const syncProductImageState = async (db, Products, ProductImages, productId) => {
  const currentImages = await loadProductImages(db, ProductImages, productId)
  const sortedImages = sortProductImages(currentImages)
  const coverId = sortedImages.find(image => image.isCover)?.ID || sortedImages[0]?.ID || null

  for (let index = 0; index < sortedImages.length; index += 1) {
    const image = sortedImages[index]
    const nextSortOrder = index + 1
    const nextIsCover = image.ID === coverId

    if ((image.sortOrder ?? nextSortOrder) !== nextSortOrder || Boolean(image.isCover) !== nextIsCover) {
      await db.run(
        UPDATE(ProductImages)
          .set({ sortOrder: nextSortOrder, isCover: nextIsCover })
          .where({ ID: image.ID })
      )
    }

    image.sortOrder = nextSortOrder
    image.isCover = nextIsCover
  }

  const coverImage = sortedImages.find(image => image.isCover)
  await db.run(
    UPDATE(Products)
      .set({ image: coverImage ? coverImage.imageUrl : null })
      .where({ ID: productId })
  )

  return sortedImages.map(image => ({
    ID: image.ID,
    imageUrl: image.imageUrl,
    isCover: Boolean(image.isCover),
    sortOrder: image.sortOrder
  }))
}

const ensureLegacyProductImage = async (db, Products, ProductImages, product) => {
  if (!product?.ID || !product.image) return []

  const existingImages = await loadProductImages(db, ProductImages, product.ID)
  if (existingImages.length) {
    return syncProductImageState(db, Products, ProductImages, product.ID)
  }

  await db.run(
    INSERT.into(ProductImages).entries({
      ID: cds.utils.uuid(),
      product_ID: product.ID,
      imageUrl: product.image,
      isCover: true,
      sortOrder: 1
    })
  )

  return syncProductImageState(db, Products, ProductImages, product.ID)
}

const loadProductDetail = async (db, Products, ProductImages, productId) => {
  const product = await db.run(
    SELECT.one.from(Products)
      .columns('ID', 'code', 'name', 'type', 'image', 'weight', 'grossPrice', 'netPrice', 'stock')
      .where({ ID: productId })
  )

  if (!product) return null

  let images = await loadProductImages(db, ProductImages, productId)
  if (!images.length && product.image) {
    images = await ensureLegacyProductImage(db, Products, ProductImages, product)
  } else {
    images = await syncProductImageState(db, Products, ProductImages, productId)
  }

  product.images = images
  product.image = images.find(image => image.isCover)?.imageUrl || product.image || null
  return product
}

const getProductImageInfo = (appFolder, imagePath) => {
  if (!imagePath) return null

  let absolutePath

  if (imagePath.startsWith('/')) {
    absolutePath = path.join(appFolder, imagePath.slice(1))
  } else if (path.isAbsolute(imagePath)) {
    absolutePath = imagePath
  } else {
    absolutePath = path.join(appFolder, imagePath)
  }

  if (!fs.existsSync(absolutePath)) return null

  const extension = path.extname(absolutePath).slice(1).toLowerCase()
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(extension)) return null

  return {
    path: absolutePath,
    extension: extension === 'jpg' ? 'jpeg' : extension
  }
}

const enrichProductsWithImages = async (db, Products, ProductImages, products) => {
  return Promise.all(products.map(product => loadProductDetail(db, Products, ProductImages, product.ID)))
}

const getExportImageColumnCount = products => {
  const maxImages = products.reduce((max, product) => Math.max(max, product.images?.length || 0), 0)
  return Math.min(MAX_PRODUCT_IMAGES, Math.max(1, maxImages))
}

const PDF_PRODUCT_IMAGE_THUMB_SIZE = 60
const PDF_PRODUCT_IMAGE_GAP = 10
const PDF_PRODUCT_IMAGE_COLUMNS = 2
const PDF_PRODUCT_IMAGE_AREA_WIDTH = 130
const PDF_PRODUCT_TEXT_GAP = 18

const buildProductExportColumns = imageColumnCount => {
  const imageColumns = Array.from({ length: imageColumnCount }, (_, index) => ({
    header: `Imagen ${index + 1}`,
    key: `image${index + 1}`,
    width: 16
  }))

  return [
    ...imageColumns,
    { header: 'Código', key: 'code', width: 18 },
    { header: 'Nombre', key: 'name', width: 32 },
    { header: 'Tipo', key: 'type', width: 16 },
    { header: 'Peso', key: 'weight', width: 12 },
    { header: 'Precio bruto', key: 'grossPrice', width: 14 },
    { header: 'Precio neto', key: 'netPrice', width: 14 },
    { header: 'Stock', key: 'stock', width: 10 },
    { header: 'Rutas imágenes', key: 'imagePaths', width: 42 }
  ]
}

const addProductImagesToWorksheet = (worksheet, workbook, appFolder, rowNumber, images, imageColumnCount) => {
  images.slice(0, imageColumnCount).forEach((image, index) => {
    const imageInfo = getProductImageInfo(appFolder, image.imageUrl)
    if (!imageInfo) return

    const imageId = workbook.addImage({
      filename: imageInfo.path,
      extension: imageInfo.extension
    })

    worksheet.addImage(imageId, {
      tl: { col: index + 0.2, row: rowNumber - 0.85 },
      ext: { width: 56, height: 56 }
    })
  })
}

const getProductImagesPdfHeight = images => {
  const thumbSize = PDF_PRODUCT_IMAGE_THUMB_SIZE
  const gap = PDF_PRODUCT_IMAGE_GAP
  const columns = PDF_PRODUCT_IMAGE_COLUMNS
  const count = Math.max(1, images.length)
  const rows = Math.ceil(count / columns)
  return rows * thumbSize + Math.max(0, rows - 1) * gap
}

const drawProductImagesInPdf = (doc, appFolder, images, startX, startY, maxWidth) => {
  const thumbSize = PDF_PRODUCT_IMAGE_THUMB_SIZE
  const gap = PDF_PRODUCT_IMAGE_GAP
  const columns = PDF_PRODUCT_IMAGE_COLUMNS
  const validImages = images
    .map(image => ({ ...image, imageInfo: getProductImageInfo(appFolder, image.imageUrl) }))
    .filter(image => image.imageInfo)

  if (!validImages.length) {
    doc.rect(startX, startY, maxWidth, thumbSize).fillAndStroke('#EEF3F8', '#DCE6F2')
    doc.fillColor('#5B738B').fontSize(9).text('Sin imágenes', startX + 12, startY + 24)
    return thumbSize
  }

  validImages.forEach((image, index) => {
    const row = Math.floor(index / columns)
    const col = index % columns
    const x = startX + (thumbSize + gap) * col
    const y = startY + (thumbSize + gap) * row
    doc.image(image.imageInfo.path, x, y, { fit: [thumbSize, thumbSize], align: 'center', valign: 'center' })
  })

  const rows = Math.ceil(validImages.length / columns)
  return rows * thumbSize + Math.max(0, rows - 1) * gap
}

const loadProductsForExport = async (db, Products, ProductImages) => {
  const products = await db.run(
    SELECT.from(Products)
      .columns('ID', 'code', 'name', 'type', 'image', 'weight', 'grossPrice', 'netPrice', 'stock')
      .orderBy('name')
  )

  return enrichProductsWithImages(db, Products, ProductImages, products)
}

const loadCampaignWithProducts = async (db, Campaigns, Products, ProductImages, ProductCampaigns, campaignId) => {
  const campaign = await db.run(
    SELECT.one.from(Campaigns)
      .columns('ID', 'name', 'description', 'startDate', 'endDate', 'client_ID')
      .where({ ID: campaignId })
  )

  if (!campaign) return null

  const assignments = await db.run(
    SELECT.from(ProductCampaigns)
      .columns('product_ID')
      .where({ campaign_ID: campaignId })
  )

  const productIds = assignments.map(assignment => assignment.product_ID)
  let products = []

  if (productIds.length) {
    products = await db.run(
      SELECT.from(Products)
        .columns('ID', 'code', 'name', 'type', 'image', 'weight', 'grossPrice', 'netPrice', 'stock')
        .where({ ID: { in: productIds } })
        .orderBy('name')
    )

      products = await enrichProductsWithImages(db, Products, ProductImages, products)
  }

  campaign.productIds = productIds
  campaign.products = products
  return campaign
}

const attachCampaignClient = async (db, Clients, campaign) => {
  if (!campaign) return campaign

  campaign.clientId = campaign.client_ID || null
  campaign.client = null

  if (!campaign.client_ID) return campaign

  const client = await db.run(
    SELECT.one.from(Clients)
      .columns('ID', 'code', 'name')
      .where({ ID: campaign.client_ID })
  )

  campaign.client = client || null
  return campaign
}

const loadClientCampaignHistory = async (db, Campaigns, clientId) => {
  if (!clientId) return []

  return db.run(
    SELECT.from(Campaigns)
      .columns('ID', 'name', 'description', 'startDate', 'endDate')
      .where({
        client_ID: clientId,
        endDate: { '<': todayIsoDate() }
      })
      .orderBy('endDate desc', 'name')
  )
}

const loadClientActiveCampaigns = async (db, Campaigns, clientId) => {
  if (!clientId) return []

  const today = todayIsoDate()

  return db.run(
    SELECT.from(Campaigns)
      .columns('ID', 'name', 'description', 'startDate', 'endDate')
      .where({
        client_ID: clientId,
        startDate: { '<=': today },
        endDate: { '>=': today }
      })
      .orderBy('startDate', 'name')
  )
}

const loadClientUpcomingCampaigns = async (db, Campaigns, clientId) => {
  if (!clientId) return []

  return db.run(
    SELECT.from(Campaigns)
      .columns('ID', 'name', 'description', 'startDate', 'endDate')
      .where({
        client_ID: clientId,
        startDate: { '>': todayIsoDate() }
      })
      .orderBy('startDate', 'name')
  )
}

const normalizeCampaign = campaign => {
  if (!campaign) return campaign
  campaign.clientId = campaign.client_ID || null
  return campaign
}

module.exports = async options => {
  const app = express()
  const appFolder = path.join(__dirname, 'app')
  const productAssetsFolder = path.join(appFolder, 'assets', 'products')
  const protectedPagePaths = new Set(['/', '/products', '/products/', '/campaigns', '/campaigns/', '/clients', '/clients/'])

  fs.mkdirSync(productAssetsFolder, { recursive: true })

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, productAssetsFolder),
    filename: (req, file, cb) => {
      const safeName = path.basename(file.originalname, path.extname(file.originalname))
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `${req.params.id}-${safeName || 'image'}${ext}`)
    }
  })

  const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      if (ALLOWED_IMAGE_EXTENSIONS.map(item => `.${item}`).includes(ext)) return cb(null, true)
      cb(new Error('Solo se permiten imágenes PNG o JPG.'))
    }
  })

  app.use('/backoffice', express.json())
  app.use((req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie)
    const session = readSessionToken(cookies[USER_SESSION_COOKIE])
    req.currentUser = findBackofficeUser(session?.username)
    req.userSession = buildUserSession(req.currentUser)
    req.userRole = req.userSession.role
    next()
  })

  app.get(['/login', '/login/'], (req, res) => {
    if (req.currentUser) return res.redirect('/')
    res.sendFile(path.join(appFolder, 'login', 'index.html'))
  })

  app.post('/backoffice/login', (req, res) => {
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    const user = authenticateBackofficeUser(username, password)

    if (!user) {
      return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' })
    }

    setSessionCookie(res, user.username)
    return res.json(buildUserSession(user))
  })

  app.post('/backoffice/logout', (_req, res) => {
    clearSessionCookie(res)
    res.json({ success: true })
  })

  app.use((req, res, next) => {
    if (!protectedPagePaths.has(req.path)) return next()
    if (req.currentUser) return next()
    return res.redirect('/login/')
  })

  app.use('/backoffice', requireAuthenticatedApi)
  app.use('/admin', requireAuthenticatedApi)

  app.use('/admin', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    if (req.userRole === 'admin') return next()
    return res.status(403).json({ message: 'Solo el perfil Administrador puede modificar datos desde el servicio OData.' })
  })

  app.use(express.static(appFolder))

  options.app = app
  options.static = false
  options.index = (_req, res) => {
    res.sendFile(path.join(appFolder, 'index.html'))
  }

  const server = await cds.server(options)
  const db = await cds.connect.to('db')
  const { Products, ProductImages, Campaigns, Clients, ProductCampaigns } = cds.entities('my.namespace')

  app.get('/backoffice/session', (_req, res) => {
    res.json(_req.userSession)
  })

  app.get('/backoffice/dashboard', authorizeModuleAccess('dashboard', 'read'), async (_req, res, next) => {
    try {
      res.json(await buildDashboardData(db, Products, Campaigns, Clients))
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/products', async (_req, res, next) => {
    try {
      const products = await loadProductsForExport(db, Products, ProductImages)

      res.json(products)
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/clients', async (_req, res, next) => {
    try {
      const clients = await db.run(
        SELECT.from(Clients)
          .columns('ID', 'code', 'name', 'contactName', 'email', 'phone', 'city', 'country')
          .orderBy('name')
      )

      res.json(clients)
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/clients/:id', async (req, res, next) => {
    try {
      const client = await db.run(
        SELECT.one.from(Clients)
          .columns('ID', 'code', 'name', 'contactName', 'email', 'phone', 'city', 'country')
          .where({ ID: req.params.id })
      )

      if (!client) return res.status(404).json({ message: 'Cliente no encontrado.' })
      client.activeCampaigns = await loadClientActiveCampaigns(db, Campaigns, req.params.id)
      client.upcomingCampaigns = await loadClientUpcomingCampaigns(db, Campaigns, req.params.id)
      client.campaignHistory = await loadClientCampaignHistory(db, Campaigns, req.params.id)
      res.json(client)
    } catch (error) {
      next(error)
    }
  })

  app.post('/backoffice/clients', authorizeModuleAccess('clients', 'write'), async (req, res, next) => {
    try {
      const payload = sanitizeClientPayload(req.body)
      payload.ID = cds.utils.uuid()

      if (!payload.code || !payload.name) {
        return res.status(400).json({ message: 'Código y nombre son obligatorios.' })
      }

      await db.run(INSERT.into(Clients).entries(payload))

      const created = await db.run(
        SELECT.one.from(Clients)
          .columns('ID', 'code', 'name', 'contactName', 'email', 'phone', 'city', 'country')
          .where({ ID: payload.ID })
      )

      res.status(201).json(created)
    } catch (error) {
      next(error)
    }
  })

  app.put('/backoffice/clients/:id', authorizeModuleAccess('clients', 'write'), async (req, res, next) => {
    try {
      const payload = sanitizeClientPayload(req.body)
      await db.run(UPDATE(Clients).set(payload).where({ ID: req.params.id }))

      const updated = await db.run(
        SELECT.one.from(Clients)
          .columns('ID', 'code', 'name', 'contactName', 'email', 'phone', 'city', 'country')
          .where({ ID: req.params.id })
      )

      if (!updated) return res.status(404).json({ message: 'Cliente no encontrado.' })
      res.json(updated)
    } catch (error) {
      next(error)
    }
  })

  app.delete('/backoffice/clients/:id', authorizeModuleAccess('clients', 'delete'), async (req, res, next) => {
    try {
      const existing = await db.run(
        SELECT.one.from(Clients)
          .columns('ID', 'name')
          .where({ ID: req.params.id })
      )

      if (!existing) return res.status(404).json({ message: 'Cliente no encontrado.' })

      await db.run(DELETE.from(Clients).where({ ID: req.params.id }))
      res.json({ message: 'Cliente eliminado correctamente.', ID: req.params.id })
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/products/export.xlsx', async (_req, res, next) => {
    try {
      const products = await loadProductsForExport(db, Products, ProductImages)
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Productos')
      const imageColumnCount = getExportImageColumnCount(products)

      worksheet.columns = buildProductExportColumns(imageColumnCount)

      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A6ED1' } }
      worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' }
      worksheet.views = [{ state: 'frozen', ySplit: 1 }]

      for (const product of products) {
        const row = worksheet.addRow({
          code: product.code,
          name: product.name,
          type: product.type,
          weight: product.weight,
          grossPrice: product.grossPrice,
          netPrice: product.netPrice,
          stock: product.stock,
          imagePaths: (product.images || []).map(image => image.imageUrl).join('\n')
        })

        row.height = 58
        row.alignment = { vertical: 'middle', wrapText: true }

        addProductImagesToWorksheet(worksheet, workbook, appFolder, row.number, product.images || [], imageColumnCount)
      }

      worksheet.getColumn('weight').numFmt = '0.00'
      worksheet.getColumn('grossPrice').numFmt = '#,##0.00'
      worksheet.getColumn('netPrice').numFmt = '#,##0.00'

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', 'attachment; filename="berlingerhaus-productos.xlsx"')
      await workbook.xlsx.write(res)
      res.end()
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/products/export.pdf', async (_req, res, next) => {
    try {
      const products = await loadProductsForExport(db, Products, ProductImages)
      const doc = new PDFDocument({ margin: 40, size: 'A4' })

      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'attachment; filename="berlingerhaus-productos.pdf"')
      doc.pipe(res)

      doc.fontSize(20).fillColor('#0A6ED1').text('BerlingerHaus · Exportación de productos')
      doc.moveDown(0.3)
      doc.fontSize(10).fillColor('#5B738B').text(`Generado: ${new Date().toLocaleString('es-ES')}`)
      doc.moveDown(1.2)

      for (const product of products) {
        const galleryHeight = getProductImagesPdfHeight(product.images || [])
        const cardHeight = Math.max(104, galleryHeight + 24)
        if (doc.y + cardHeight > 780) doc.addPage()

        const top = doc.y
        doc.roundedRect(40, top, 515, cardHeight, 12).fillAndStroke('#F9FBFD', '#DCE6F2')

        const textStartX = 52 + PDF_PRODUCT_IMAGE_AREA_WIDTH + PDF_PRODUCT_TEXT_GAP
        const textWidth = 555 - textStartX - 20

        drawProductImagesInPdf(doc, appFolder, product.images || [], 52, top + 12, PDF_PRODUCT_IMAGE_AREA_WIDTH)

        doc.fillColor('#1D2D3E').fontSize(14).text(product.name || 'Sin nombre', textStartX, top + 12, { width: textWidth })
        doc.fontSize(10).fillColor('#5B738B').text(`Código: ${product.code || '-'}`, textStartX, top + 36)
        doc.text(`Tipo: ${product.type || '-'}`, textStartX, top + 52)
        doc.text(`Peso: ${product.weight ?? '-'} kg`, textStartX, top + 68)
        doc.text(`Precio bruto: ${product.grossPrice ?? '-'} €`, textStartX + 168, top + 36)
        doc.text(`Precio neto: ${product.netPrice ?? '-'} €`, textStartX + 168, top + 52)
        doc.text(`Stock: ${product.stock ?? 0}`, textStartX + 168, top + 68)
        doc.moveDown(0.8)
        doc.y = top + cardHeight + 16
      }

      doc.end()
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/products/:id', async (req, res, next) => {
    try {
      const product = await loadProductDetail(db, Products, ProductImages, req.params.id)

      if (!product) return res.status(404).json({ message: 'Producto no encontrado.' })
      res.json(product)
    } catch (error) {
      next(error)
    }
  })

  app.post('/backoffice/products', authorizeModuleAccess('products', 'write'), async (req, res, next) => {
    try {
      const payload = sanitizeProductPayload(req.body)
      payload.ID = cds.utils.uuid()

      if (!payload.code || !payload.name || !payload.type) {
        return res.status(400).json({ message: 'Código, nombre y tipo son obligatorios.' })
      }

      await db.run(INSERT.into(Products).entries(payload))

      const created = await loadProductDetail(db, Products, ProductImages, payload.ID)

      res.status(201).json(created)
    } catch (error) {
      next(error)
    }
  })

  app.put('/backoffice/products/:id', authorizeModuleAccess('products', 'write'), async (req, res, next) => {
    try {
      const payload = sanitizeProductPayload(req.body)
      await db.run(UPDATE(Products).set(payload).where({ ID: req.params.id }))

      const updated = await loadProductDetail(db, Products, ProductImages, req.params.id)

      res.json(updated)
    } catch (error) {
      next(error)
    }
  })

  app.delete('/backoffice/products/:id', authorizeModuleAccess('products', 'delete'), async (req, res, next) => {
    try {
      const existing = await db.run(
        SELECT.one.from(Products)
          .columns('ID', 'code', 'name')
          .where({ ID: req.params.id })
      )

      if (!existing) return res.status(404).json({ message: 'Producto no encontrado.' })

      await db.run(DELETE.from(ProductCampaigns).where({ product_ID: req.params.id }))
      const productImages = await loadProductImages(db, ProductImages, req.params.id)
      await db.run(DELETE.from(ProductImages).where({ product_ID: req.params.id }))
      await db.run(DELETE.from(Products).where({ ID: req.params.id }))

      for (const image of productImages) {
        const imageInfo = getProductImageInfo(appFolder, image.imageUrl)
        if (isManagedProductUpload(req.params.id, imageInfo?.path)) removeFileIfExists(imageInfo.path)
      }

      res.json({ message: 'Producto eliminado correctamente.', ID: req.params.id })
    } catch (error) {
      next(error)
    }
  })

  app.post('/backoffice/products/:id/image', authorizeModuleAccess('products', 'write'), upload.single('image'), async (req, res, next) => {
    try {
      req.files = req.file ? [req.file] : []
      if (!req.files.length) return res.status(400).json({ message: 'Debes seleccionar una imagen.' })

      const product = await loadProductDetail(db, Products, ProductImages, req.params.id)
      if (!product) {
        removeFileIfExists(req.files[0]?.path)
        return res.status(404).json({ message: 'Producto no encontrado.' })
      }

      const uploadedImage = req.files[0]
      const currentImages = product.images || []

      if (currentImages.length >= MAX_PRODUCT_IMAGES) {
        removeFileIfExists(uploadedImage.path)
        return res.status(400).json({ message: `Solo se permiten ${MAX_PRODUCT_IMAGES} imágenes por producto.` })
      }

      await db.run(
        INSERT.into(ProductImages).entries({
          ID: cds.utils.uuid(),
          product_ID: req.params.id,
          imageUrl: `/assets/products/${uploadedImage.filename}`,
          isCover: currentImages.length === 0,
          sortOrder: currentImages.length + 1
        })
      )

      const updated = await loadProductDetail(db, Products, ProductImages, req.params.id)
      res.json(updated)
    } catch (error) {
      for (const file of req.files || []) removeFileIfExists(file.path)
      next(error)
    }
  })

  app.post('/backoffice/products/:id/images', authorizeModuleAccess('products', 'write'), upload.array('images', MAX_PRODUCT_IMAGES), async (req, res, next) => {
    try {
      if (!req.files?.length) return res.status(400).json({ message: 'Debes seleccionar al menos una imagen.' })

      const product = await loadProductDetail(db, Products, ProductImages, req.params.id)
      if (!product) {
        for (const file of req.files) removeFileIfExists(file.path)
        return res.status(404).json({ message: 'Producto no encontrado.' })
      }

      const currentImages = product.images || []
      const remainingSlots = MAX_PRODUCT_IMAGES - currentImages.length

      if (req.files.length > remainingSlots) {
        for (const file of req.files) removeFileIfExists(file.path)
        return res.status(400).json({ message: `Este producto ya tiene ${currentImages.length} imágenes. Solo puedes añadir ${remainingSlots} más.` })
      }

      await db.run(
        INSERT.into(ProductImages).entries(
          req.files.map((file, index) => ({
            ID: cds.utils.uuid(),
            product_ID: req.params.id,
            imageUrl: `/assets/products/${file.filename}`,
            isCover: currentImages.length === 0 && index === 0,
            sortOrder: currentImages.length + index + 1
          }))
        )
      )

      const updated = await loadProductDetail(db, Products, ProductImages, req.params.id)
      res.json(updated)
    } catch (error) {
      for (const file of req.files || []) removeFileIfExists(file.path)
      next(error)
    }
  })

  app.post('/backoffice/products/:id/images/:imageId/cover', authorizeModuleAccess('products', 'write'), async (req, res, next) => {
    try {
      const product = await loadProductDetail(db, Products, ProductImages, req.params.id)
      if (!product) return res.status(404).json({ message: 'Producto no encontrado.' })

      const targetImage = (product.images || []).find(image => image.ID === req.params.imageId)
      if (!targetImage) return res.status(404).json({ message: 'Imagen no encontrada para este producto.' })

      await db.run(UPDATE(ProductImages).set({ isCover: false }).where({ product_ID: req.params.id }))
      await db.run(UPDATE(ProductImages).set({ isCover: true }).where({ ID: req.params.imageId }))

      const updated = await loadProductDetail(db, Products, ProductImages, req.params.id)
      res.json(updated)
    } catch (error) {
      next(error)
    }
  })

  app.delete('/backoffice/products/:id/images/:imageId', authorizeModuleAccess('products', 'write'), async (req, res, next) => {
    try {
      const product = await loadProductDetail(db, Products, ProductImages, req.params.id)
      if (!product) return res.status(404).json({ message: 'Producto no encontrado.' })

      const targetImage = (product.images || []).find(image => image.ID === req.params.imageId)
      if (!targetImage) return res.status(404).json({ message: 'Imagen no encontrada para este producto.' })

      await db.run(DELETE.from(ProductImages).where({ ID: req.params.imageId, product_ID: req.params.id }))

      const imageInfo = getProductImageInfo(appFolder, targetImage.imageUrl)
    if (isManagedProductUpload(req.params.id, imageInfo?.path)) removeFileIfExists(imageInfo.path)

      const updated = await loadProductDetail(db, Products, ProductImages, req.params.id)
      res.json(updated)
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/campaigns', async (_req, res, next) => {
    try {
      const campaigns = await db.run(
        SELECT.from(Campaigns)
          .columns('ID', 'name', 'description', 'startDate', 'endDate', 'client_ID', 'createdAt')
          .orderBy('startDate desc', 'name')
      )

      const enrichedCampaigns = await Promise.all(campaigns.map(campaign => attachCampaignClient(db, Clients, normalizeCampaign(campaign))))
      res.json(enrichedCampaigns)
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/campaigns/:id', async (req, res, next) => {
    try {
      const campaign = await loadCampaignWithProducts(db, Campaigns, Products, ProductImages, ProductCampaigns, req.params.id)
      if (!campaign) return res.status(404).json({ message: 'Campaña no encontrada.' })
      delete campaign.products
      res.json(await attachCampaignClient(db, Clients, normalizeCampaign(campaign)))
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/campaigns/:id/export.xlsx', async (req, res, next) => {
    try {
      const campaign = await attachCampaignClient(
        db,
        Clients,
        normalizeCampaign(await loadCampaignWithProducts(db, Campaigns, Products, ProductImages, ProductCampaigns, req.params.id))
      )
      if (!campaign) return res.status(404).json({ message: 'Campaña no encontrada.' })

      const workbook = new ExcelJS.Workbook()
      const summarySheet = workbook.addWorksheet('Campaña')
      const productsSheet = workbook.addWorksheet('Productos')
      const imageColumnCount = getExportImageColumnCount(campaign.products)

      summarySheet.columns = [
        { header: 'Campo', key: 'field', width: 24 },
        { header: 'Valor', key: 'value', width: 50 }
      ]
      summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
      summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A6ED1' } }
      summarySheet.addRows([
        { field: 'Nombre', value: campaign.name },
        { field: 'Cliente', value: campaign.client?.name || 'Sin cliente asignado' },
        { field: 'Descripción', value: campaign.description || '' },
        { field: 'Fecha inicio', value: campaign.startDate || '' },
        { field: 'Fecha fin', value: campaign.endDate || '' },
        { field: 'Productos asignados', value: campaign.products.length }
      ])
      summarySheet.eachRow(row => {
        row.alignment = { vertical: 'middle', wrapText: true }
      })

      productsSheet.columns = buildProductExportColumns(imageColumnCount)
      productsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
      productsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A6ED1' } }
      productsSheet.views = [{ state: 'frozen', ySplit: 1 }]

      for (const product of campaign.products) {
        const row = productsSheet.addRow({
          code: product.code,
          name: product.name,
          type: product.type,
          weight: product.weight,
          grossPrice: product.grossPrice,
          netPrice: product.netPrice,
          stock: product.stock,
          imagePaths: (product.images || []).map(image => image.imageUrl).join('\n')
        })

        row.height = 58
        row.alignment = { vertical: 'middle', wrapText: true }

        addProductImagesToWorksheet(productsSheet, workbook, appFolder, row.number, product.images || [], imageColumnCount)
      }

      productsSheet.getColumn('weight').numFmt = '0.00'
      productsSheet.getColumn('grossPrice').numFmt = '#,##0.00'
      productsSheet.getColumn('netPrice').numFmt = '#,##0.00'

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="campana-${campaign.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'export'}.xlsx"`)
      await workbook.xlsx.write(res)
      res.end()
    } catch (error) {
      next(error)
    }
  })

  app.get('/backoffice/campaigns/:id/export.pdf', async (req, res, next) => {
    try {
      const campaign = await attachCampaignClient(
        db,
        Clients,
        normalizeCampaign(await loadCampaignWithProducts(db, Campaigns, Products, ProductImages, ProductCampaigns, req.params.id))
      )
      if (!campaign) return res.status(404).json({ message: 'Campaña no encontrada.' })

      const doc = new PDFDocument({ margin: 40, size: 'A4' })
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="campana-${campaign.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'export'}.pdf"`)
      doc.pipe(res)

      doc.fontSize(20).fillColor('#0A6ED1').text(`Campaña · ${campaign.name}`)
      doc.moveDown(0.5)
      doc.fontSize(11).fillColor('#1D2D3E').text(`Cliente: ${campaign.client?.name || '-'}`)
      doc.fontSize(11).fillColor('#1D2D3E').text(`Descripción: ${campaign.description || '-'}`)
      doc.text(`Inicio: ${campaign.startDate || '-'}`)
      doc.text(`Fin: ${campaign.endDate || '-'}`)
      doc.text(`Productos asignados: ${campaign.products.length}`)
      doc.moveDown(1)

      if (!campaign.products.length) {
        doc.fontSize(11).fillColor('#5B738B').text('No hay productos asignados a esta campaña.')
      }

      for (const product of campaign.products) {
        const galleryHeight = getProductImagesPdfHeight(product.images || [])
        const cardHeight = Math.max(104, galleryHeight + 24)
        if (doc.y + cardHeight > 780) doc.addPage()

        const top = doc.y
        doc.roundedRect(40, top, 515, cardHeight, 12).fillAndStroke('#F9FBFD', '#DCE6F2')

        const textStartX = 52 + PDF_PRODUCT_IMAGE_AREA_WIDTH + PDF_PRODUCT_TEXT_GAP
        const textWidth = 555 - textStartX - 20

        drawProductImagesInPdf(doc, appFolder, product.images || [], 52, top + 12, PDF_PRODUCT_IMAGE_AREA_WIDTH)

        doc.fillColor('#1D2D3E').fontSize(14).text(product.name || 'Sin nombre', textStartX, top + 12, { width: textWidth })
        doc.fontSize(10).fillColor('#5B738B').text(`Código: ${product.code || '-'}`, textStartX, top + 36)
        doc.text(`Tipo: ${product.type || '-'}`, textStartX, top + 52)
        doc.text(`Peso: ${product.weight ?? '-'} kg`, textStartX, top + 68)
        doc.text(`Precio bruto: ${product.grossPrice ?? '-'} €`, textStartX + 168, top + 36)
        doc.text(`Precio neto: ${product.netPrice ?? '-'} €`, textStartX + 168, top + 52)
        doc.text(`Stock: ${product.stock ?? 0}`, textStartX + 168, top + 68)
        doc.y = top + cardHeight + 16
      }

      doc.end()
    } catch (error) {
      next(error)
    }
  })

  app.post('/backoffice/campaigns', authorizeModuleAccess('campaigns', 'write'), async (req, res, next) => {
    try {
      const payload = sanitizeCampaignPayload(req.body)
      const productIds = normalizeProductIds(req.body.productIds)
      payload.ID = cds.utils.uuid()

      if (!payload.name) {
        return res.status(400).json({ message: 'El nombre de la campaña es obligatorio.' })
      }

      if (payload.client_ID) {
        const existingClient = await db.run(SELECT.one.from(Clients).columns('ID').where({ ID: payload.client_ID }))
        if (!existingClient) {
          return res.status(400).json({ message: 'El cliente seleccionado no existe.' })
        }
      }

      await db.run(INSERT.into(Campaigns).entries(payload))
      await syncCampaignProducts(db, ProductCampaigns, payload.ID, productIds)

      const created = await db.run(
        SELECT.one.from(Campaigns)
          .columns('ID', 'name', 'description', 'startDate', 'endDate', 'client_ID')
          .where({ ID: payload.ID })
      )

      created.productIds = productIds
      res.status(201).json(await attachCampaignClient(db, Clients, normalizeCampaign(created)))
    } catch (error) {
      next(error)
    }
  })

  app.put('/backoffice/campaigns/:id', authorizeModuleAccess('campaigns', 'write'), async (req, res, next) => {
    try {
      const payload = sanitizeCampaignPayload(req.body)
      const productIds = normalizeProductIds(req.body.productIds)

      if (payload.client_ID) {
        const existingClient = await db.run(SELECT.one.from(Clients).columns('ID').where({ ID: payload.client_ID }))
        if (!existingClient) {
          return res.status(400).json({ message: 'El cliente seleccionado no existe.' })
        }
      }

      await db.run(UPDATE(Campaigns).set(payload).where({ ID: req.params.id }))
      await syncCampaignProducts(db, ProductCampaigns, req.params.id, productIds)

      const updated = await db.run(
        SELECT.one.from(Campaigns)
          .columns('ID', 'name', 'description', 'startDate', 'endDate', 'client_ID')
          .where({ ID: req.params.id })
      )

      updated.productIds = productIds
      res.json(await attachCampaignClient(db, Clients, normalizeCampaign(updated)))
    } catch (error) {
      next(error)
    }
  })

  app.delete('/backoffice/campaigns/:id', authorizeModuleAccess('campaigns', 'delete'), async (req, res, next) => {
    try {
      const existing = await db.run(
        SELECT.one.from(Campaigns)
          .columns('ID', 'name')
          .where({ ID: req.params.id })
      )

      if (!existing) return res.status(404).json({ message: 'Campaña no encontrada.' })

      await db.run(DELETE.from(ProductCampaigns).where({ campaign_ID: req.params.id }))
      await db.run(DELETE.from(Campaigns).where({ ID: req.params.id }))

      res.json({ message: 'Campaña eliminada correctamente.', ID: req.params.id })
    } catch (error) {
      next(error)
    }
  })

  app.use('/backoffice', (error, _req, res, _next) => {
    res.status(400).json({ message: error.message || 'No se pudo procesar la solicitud.' })
  })

  return server
}
