# COLUN · Cuadro de resultado

Página privada para consultar `public.colun_colun_cuadroresultado` en PostgreSQL de Finnegans.

## Uso

La página consulta el origen al abrirse. **Actualizar** vuelve a contar los registros y carga la primera página. La grilla muestra 50 filas por página y todas las columnas; permite ir directamente a una página y saltar horizontalmente a una columna.

**Exportar a Excel** genera el dataset completo en segundo plano. Cuando termina aparece **Descargar Excel**. Los valores se exportan como texto, tal como están almacenados, para preservar identificadores, ceros iniciales, fechas e importes. Si el dataset supera el límite por hoja, se crean hojas adicionales automáticamente. No hay un límite artificial de filas en la exportación.

## Arquitectura

`Navegador → Site privado → pasarela HTTPS con token → PostgreSQL (TLS, solo lectura)`

- Sites controla el acceso privado del propietario.
- El Worker usa dos secretos de runtime: `BRIDGE_URL` y `BRIDGE_TOKEN`.
- La contraseña de PostgreSQL y el token de la pasarela están únicamente en memoria del proceso local; no se incluyen en el código, el navegador ni el repositorio.
- Todas las rutas de la pasarela requieren el token. Solo se exponen consultas prefijadas y la exportación de esta tabla; no se acepta SQL del cliente.
- PostgreSQL se consulta en transacciones de solo lectura. La exportación obtiene un snapshot con COPY binario en una transacción de lectura repetible, lo transfiere directamente a un archivo temporal y libera la conexión antes de generar Excel. La escritura de Excel usa memoria constante y preserva NULL, cadenas vacías y Unicode.
- Cada exportación verifica que las filas escritas coincidan con el conteo de su snapshot.
- Los archivos de exportación son temporales, quedan fuera del repositorio y se eliminan al cerrar la pasarela o iniciar una nueva exportación.
- El orden de la grilla usa la ubicación física de la fila (`ctid`). Una actualización del Data Warehouse puede cambiar el orden entre páginas; **Actualizar** inicia una nueva consulta en la primera página. La exportación incluye todo el snapshot independientemente del orden.

## Disponibilidad de la conexión

La pasarela y el túnel HTTPS de esta entrega se ejecutan en este equipo. El Site permanece publicado, pero las consultas y la generación/descarga de Excel requieren que ambos procesos sigan activos y que el equipo tenga conexión a Internet.

El túnel de esta entrega es temporal. Al reiniciarlo cambia su URL y se deben actualizar los secretos de Sites y desplegar una versión que aplique esa configuración. Para reactivarlo sin guardar credenciales en archivos, pedí en este chat que se restablezca la pasarela. Para funcionamiento permanente se necesita desplegar esta pasarela en un servidor con acceso a PostgreSQL y una URL HTTPS estable, o configurar un túnel permanente de Cloudflare en una cuenta del usuario.

## Desarrollo y validación

No hay dependencias JavaScript de compilación. `node build.mjs` genera `dist/server/index.js` y copia el manifiesto de hosting.

La pasarela requiere Python y los paquetes de `requirements.txt`. `python gateway.py --stdin-config` solicita un objeto JSON oculto con `password` y `token`. No pasar secretos por argumentos de comandos ni escribirlos en archivos.

`checks.py` comprueba la protección de acceso, la primera/segunda/última página, las 68 columnas, la conexión HTTPS, la exportación de datos reales, el cambio de hoja y la preservación literal de fórmulas, Unicode y ceros iniciales. Solicita configuración oculta por stdin y no imprime datos contables ni secretos.

`preview.mjs` reproduce localmente el Worker; se usa solo para validación, y debe cerrarse al terminar. La página publicada utiliza la pasarela real por HTTPS.

## GitHub y próximo despliegue en Vercel

Este repositorio contiene la versión actual de la publicación en Sites y su pasarela PostgreSQL. No incluye contraseñas, tokens, exportaciones ni copias de los datos.

La migración a Vercel todavía requiere adaptar el Worker a rutas de servidor compatibles, configurar los secretos de conexión y mantener el estado de las exportaciones y sus archivos en almacenamiento persistente. El acceso privado actual lo proporciona Sites; en Vercel se debe configurar autenticación para la página, la API y las descargas antes de habilitar consultas al Data Warehouse.
