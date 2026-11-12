# COLUN · Libro Mayor

Página independiente, sin login propio, preparada para abrirse mediante un enlace externo desde Finnegans. Consulta `public.colun_colun_cuadroresultado` con paginación de 100 filas y exportación completa a Excel.

## Despliegue en Vercel

El proyecto utiliza Node.js 22, una interfaz estática y una única API del servidor. `vercel.json` configura la compilación, las rutas, la región `iad1` y las funciones de hasta 300 segundos del plan Hobby.

1. Importar `FisterraSRL/ColunLibroMayor` en Vercel y utilizar la rama `main`.
2. Guardar `PGPASSWORD` como secreto del entorno Production. Las credenciales no van en el repositorio ni en el navegador.
3. Conectar un almacén Vercel Blob **privado**, en `iad1`, al mismo proyecto. La conexión proporciona `BLOB_STORE_ID` y utiliza la identidad OIDC de Vercel; también admite `BLOB_READ_WRITE_TOKEN` cuando la conexión lo requiera.
4. Desplegar y comprobar `/api/health`, la grilla, Actualizar y Exportar a Excel.

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

La página consulta el origen al abrirse. **Actualizar** vuelve a contar los registros y muestra la primera página. Todas las columnas están disponibles; el selector de columnas permite elegir cuáles aparecen en la grilla y conserva la selección en este navegador. También se puede saltar horizontalmente a una columna visible y navegar directamente a cualquier página.

**Exportar a Excel** prepara un snapshot consistente del origen en bloques comprimidos del almacenamiento privado y libera PostgreSQL antes de generar el archivo. Una segunda etapa escribe el XLSX como un flujo con ZIP64, sin archivos grandes en disco ni un proceso local permanente. El estado persistente permite continuar tras recargar la página. Mantené la página abierta hasta ver **Descargar Excel**.

La exportación incluye todas las filas y columnas. Los valores se escriben como texto para conservar identificadores, ceros iniciales, fechas, importes y fórmulas literales. Si se supera el límite de filas de una hoja, se crean hojas adicionales. Los campos que excedan el límite de caracteres de Excel producen un error explícito y no se truncan.

Solo se ejecuta una exportación completa a la vez. Se conserva el último archivo; comenzar una nueva exportación reemplaza los archivos temporales anteriores. Los enlaces vencen a las 24 horas. El consumo de Blob y transferencias está sujeto a las cuotas del plan de Vercel.

## Acceso

Por decisión del propietario, esta aplicación no agrega usuario, contraseña ni validación de sesión de Finnegans. Puede abrirse directamente por su URL o mediante un enlace externo. Las credenciales de PostgreSQL y del almacenamiento permanecen en el servidor. No se acepta SQL del navegador; la API solo consulta la tabla configurada.

## Desarrollo

- Instalar dependencias con `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` genera la interfaz en `public/`.
- `pnpm check` comprueba la sintaxis de la API.
- `api/index.mjs` implementa las consultas, el estado durable y el generador XLSX.
- `static/` contiene la interfaz.

La pasarela Python (`gateway.py`), `worker.mjs`, `build.mjs`, `preview.mjs` y `.openai/hosting.json` se conservan como referencia de la publicación anterior en Sites. El despliegue de Vercel no los utiliza y no requiere la pasarela ni el túnel de aquel prototipo.
