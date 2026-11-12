# COLUN · Libro Mayor

Página independiente, sin login propio, preparada para abrirse mediante un enlace externo desde Finnegans. Consulta `public.colun_colun_cuadroresultado` con un filtro móvil de 12 meses hasta la fecha elegida, paginación de 100 filas y exportación a Excel del período y las columnas visibles.

## Despliegue en Vercel

El proyecto utiliza Node.js 22, una interfaz estática y una única API del servidor. `vercel.json` configura la compilación, las rutas, la región `iad1` y las funciones de hasta 300 segundos del plan Hobby.

1. Importar `FisterraSRL/ColunLibroMayor` en Vercel y utilizar la rama `main`.
2. Guardar `PGPASSWORD` como secreto del entorno Production. Las credenciales no van en el repositorio ni en el navegador.
3. Desplegar y comprobar `/api/health`, la grilla, Actualizar y Exportar a Excel. La exportación directa no requiere Vercel Blob.

Valores de PostgreSQL configurables en el servidor:

| Variable | Valor predeterminado |
| --- | --- |
| PGHOST | finnegans-bi-1.postgres.database.azure.com |
| PGPORT | 5432 |
| PGDATABASE | finnegansbi |
| PGUSER | colunuser |
| PGPASSWORD | Secreto obligatorio, sin valor predeterminado |

La conexión usa TLS con verificación de certificado y transacciones de solo lectura. Si Finnegans restringe las IP de origen, debe habilitarse el servidor que realiza las consultas.

## Uso

La página consulta el origen al abrirse con la fecha actual como **Fecha hasta**. El rango incluye desde el mismo día del año anterior hasta la fecha elegida, inclusive. **Actualizar** aplica la fecha, vuelve a contar los registros y muestra la primera página. Todas las columnas están disponibles; el selector permite elegir cuáles aparecen en la grilla y conserva la selección en este navegador. También se puede saltar horizontalmente a una columna visible y navegar directamente a cualquier página.

**Exportar a Excel** consulta PostgreSQL en una transacción de solo lectura y genera el XLSX como flujo ZIP64 directamente para la descarga. No usa Vercel Blob. Mantené la página abierta hasta que aparezca **Descargar Excel**; la generación puede tardar varios minutos para períodos grandes.

La exportación incluye todas las filas del período, en todas las páginas, y solo las columnas visibles en la grilla, en el mismo orden. Los valores se escriben como texto para conservar identificadores, ceros iniciales, fechas, importes y fórmulas literales. Si se supera el límite de filas de una hoja, se crean hojas adicionales. Los campos que excedan el límite de caracteres de Excel producen un error explícito y no se truncan.

El archivo preparado permanece disponible en la pestaña actual mientras no se recargue la página. La función de Vercel dispone de hasta 300 segundos para completar la descarga.

## Acceso

Por decisión del propietario, esta aplicación no agrega usuario, contraseña ni validación de sesión de Finnegans. Puede abrirse directamente por su URL o mediante un enlace externo. Las credenciales de PostgreSQL y del almacenamiento permanecen en el servidor. No se acepta SQL del navegador; la API solo consulta la tabla configurada.

## Desarrollo

- Instalar dependencias con `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` genera la interfaz en `public/`.
- `pnpm check` comprueba la sintaxis de la API.
- `api/index.mjs` implementa las consultas, el estado durable y el generador XLSX.
- `static/` contiene la interfaz.

La pasarela Python (`gateway.py`), `worker.mjs`, `build.mjs`, `preview.mjs` y `.openai/hosting.json` se conservan como referencia de la publicación anterior en Sites. El despliegue de Vercel no los utiliza y no requiere la pasarela ni el túnel de aquel prototipo.
