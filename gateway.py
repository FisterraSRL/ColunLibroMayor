"""Read-only PostgreSQL gateway. All routes require the server-side bearer token."""
import concurrent.futures
import contextlib
import datetime
import getpass
import hmac
import json
import math
import os
from pathlib import Path
import shutil
import ssl
import struct
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
import uuid

sys.path.insert(0, str(Path(__file__).parent / '.runtime'))
sys.path.insert(0, os.path.join(os.environ.get('TEMP', tempfile.gettempdir()), 'codex-pg-client-fast'))
import pg8000.dbapi
import xlsxwriter

TABLE = 'public.colun_colun_cuadroresultado'
PAGE_SIZE = 50
EXCEL_ROWS = 1048575  # one additional row is reserved for the header
CONFIG = {}
META = {}
META_LOCK = threading.Lock()
JOBS = {}
JOB_LOCK = threading.Lock()
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1)
EXPORT_DIR = tempfile.TemporaryDirectory(prefix='colun-excel-')


@contextlib.contextmanager
def database(timeout=60):
    connection = pg8000.dbapi.connect(
        host='finnegans-bi-1.postgres.database.azure.com', port=5432,
        database='finnegansbi', user='colunuser', password=CONFIG['password'],
        ssl_context=ssl.create_default_context(), timeout=timeout,
        application_name='COLUN_Private_Grid',
    )
    try:
        cursor = connection.cursor()
        cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        cursor.execute("SET LOCAL statement_timeout = '55s'")
        yield cursor
    finally:
        connection.rollback()
        connection.close()


def metadata(refresh=False):
    with META_LOCK:
        if META and not refresh and time.monotonic() - META['_cached'] < 60:
            return {k: v for k, v in META.items() if k != '_cached'}
        with database() as cursor:
            cursor.execute('SELECT column_name FROM information_schema.columns '
                           "WHERE table_schema='public' AND table_name='colun_colun_cuadroresultado' "
                           'ORDER BY ordinal_position')
            columns = [r[0] for r in cursor.fetchall()]
            cursor.execute('SELECT count(*) FROM ' + TABLE)
            total = cursor.fetchone()[0]
        result = dict(columns=columns, total=total, pageSize=PAGE_SIZE,
                      pages=max(1, math.ceil(total / PAGE_SIZE)), table=TABLE,
                      checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        META.clear()
        META.update(result, _cached=time.monotonic())
        return result


def rows(page):
    meta = metadata()
    if page < 1 or page > meta['pages']:
        raise ValueError('La página está fuera de rango.')
    with database() as cursor:
        # Physical row order provides a complete deterministic order within this query.
        # ETL updates can change it between requests; Actualizar starts at page one.
        cursor.execute('SELECT * FROM ' + TABLE + ' ORDER BY ctid LIMIT %s OFFSET %s',
                       (PAGE_SIZE, (page - 1) * PAGE_SIZE))
        result = cursor.fetchall()
    return dict(rows=result, page=page, pageSize=PAGE_SIZE, total=meta['total'],
                pages=meta['pages'], columns=meta['columns'])


def update_job(job_id, **values):
    with JOB_LOCK:
        JOBS[job_id].update(values)


def write_workbook(cursor, path, columns, progress=lambda count: None, sheet_limit=EXCEL_ROWS):
    """Fetch a server cursor in bounded batches; write all cells literally as text."""
    workbook = xlsxwriter.Workbook(str(path), {'constant_memory': True,
                                             'strings_to_formulas': False,
                                             'strings_to_urls': False})
    # A million rows x 68 fields can exceed ZIP's 2/4 GiB internal XML limits.
    workbook.use_zip64()
    header = workbook.add_format({'bold': True, 'bg_color': '#147966',
                                  'font_color': '#FFFFFF', 'text_wrap': True})
    text = workbook.add_format({'num_format': '@', 'font_size': 10})
    sheet = None
    row = 0
    total = 0
    sheet_number = 0

    def new_sheet():
        nonlocal sheet, row, sheet_number
        sheet_number += 1
        sheet = workbook.add_worksheet('CuadroResultado' + (f'_{sheet_number}' if sheet_number > 1 else ''))
        sheet.freeze_panes(1, 0)
        sheet.set_row(0, 32)
        sheet.set_column(0, len(columns) - 1, 24, text)
        sheet.write_row(0, 0, columns, header)
        row = 1

    new_sheet()
    try:
        while True:
            cursor.execute('FETCH FORWARD 1000 FROM export_rows')
            batch = cursor.fetchall()
            if not batch:
                break
            for values in batch:
                if row > sheet_limit:
                    sheet.autofilter(0, 0, row - 1, len(columns) - 1)
                    new_sheet()
                for col, value in enumerate(values):
                    if value is not None:
                        value = str(value)
                        if len(value) > 32767:
                            raise ValueError('Un campo supera los 32.767 caracteres admitidos por Excel. No se truncó el dato.')
                        sheet.write_string(row, col, value)
                row += 1
                total += 1
            progress(total)
        sheet.autofilter(0, 0, row - 1, len(columns) - 1)
    finally:
        workbook.close()
    return total, sheet_number


class BinaryCursor:
    """Read PostgreSQL COPY BINARY text columns without losing NULL or empty strings."""
    def __init__(self, stream, columns):
        self.stream = stream
        self.columns = columns
        if stream.read(11) != b'PGCOPY\n\xff\r\n\x00':
            raise ValueError('El snapshot de exportación no es válido.')
        flags, extra = struct.unpack('!ii', stream.read(8))
        if flags:
            raise ValueError('El formato del snapshot no es compatible.')
        stream.read(extra)
        self.done = False

    def execute(self, _query):
        pass

    def fetchall(self):
        result = []
        while not self.done and len(result) < 1000:
            count = struct.unpack('!h', self.stream.read(2))[0]
            if count == -1:
                self.done = True
                break
            if count != self.columns:
                raise ValueError('El snapshot tiene una cantidad de columnas inesperada.')
            row = []
            for _ in range(count):
                length = struct.unpack('!i', self.stream.read(4))[0]
                row.append(None if length == -1 else self.stream.read(length).decode('utf-8'))
            result.append(row)
        return result


def export_job(job_id):
    path = Path(EXPORT_DIR.name) / (job_id + '.xlsx')
    spool = Path(EXPORT_DIR.name) / (job_id + '.pgcopy')
    try:
        update_job(job_id, phase='reading')
        with database(timeout=330) as cursor:
            cursor.execute("SET LOCAL lock_timeout = '5s'")
            cursor.execute("SET LOCAL statement_timeout = '300s'")
            cursor.execute('SELECT * FROM ' + TABLE + ' LIMIT 0')
            columns = [c[0] for c in cursor.description]
            cursor.execute('SELECT count(*) FROM ' + TABLE)
            total = cursor.fetchone()[0]
            update_job(job_id, total=total, columns=len(columns), status='running')
            # Transfer directly to disk, then release PostgreSQL BEFORE formatting Excel.
            # This avoids holding a table lock during the lengthy workbook generation.
            with spool.open('wb') as stream:
                cursor.execute('COPY ' + TABLE + ' TO STDOUT (FORMAT BINARY)', stream=stream)
        update_job(job_id, phase='writing')
        with spool.open('rb') as stream:
            count, sheets = write_workbook(BinaryCursor(stream, len(columns)), path, columns,
                                          lambda n: update_job(job_id, processed=n,
                                            phase='finalizing' if n == total else 'writing'))
        if count != total:
            raise RuntimeError('La cantidad exportada no coincide con el total del snapshot.')
        update_job(job_id, status='ready', processed=count, sheets=sheets,
                   bytes=path.stat().st_size,
                   completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    except Exception as error:
        update_job(job_id, status='error', error=(str(error) if isinstance(error, ValueError)
                   else 'No se pudo completar la exportación. Verificá la conexión y volvé a intentar.'))
        print('Export failed:', type(error).__name__, flush=True)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
    finally:
        spool.unlink(missing_ok=True)


def start_export():
    with JOB_LOCK:
        for job in JOBS.values():
            if job['status'] in ('queued', 'running'):
                return dict(job)
        # Keep at most the last completed export on this machine.
        for path in Path(EXPORT_DIR.name).glob('*.xlsx'):
            path.unlink(missing_ok=True)
        JOBS.clear()
        job_id = uuid.uuid4().hex
        job = dict(id=job_id, status='queued', processed=0, total=0,
                   createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        JOBS[job_id] = job
        POOL.submit(export_job, job_id)
        return dict(job)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, format, *args):
        # Do not log URLs, bearer headers, data or credentials.
        pass

    def send_json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        received = self.headers.get('Authorization', '')
        return hmac.compare_digest(received, 'Bearer ' + CONFIG['token'])

    def do_GET(self):
        if not self.authorized():
            return self.send_json({'error': 'Acceso no autorizado.'}, 401)
        url = urlparse(self.path)
        query = parse_qs(url.query)
        try:
            if url.path == '/api/metadata':
                return self.send_json(metadata(query.get('refresh') == ['1']))
            if url.path == '/api/rows':
                return self.send_json(rows(int(query.get('page', ['1'])[0])))
            parts = url.path.strip('/').split('/')
            if len(parts) in (3, 4) and parts[:2] == ['api', 'exports']:
                with JOB_LOCK:
                    job = dict(JOBS.get(parts[2], {}))
                if not job:
                    return self.send_json({'error': 'La exportación venció o no existe.'}, 404)
                if len(parts) == 3:
                    return self.send_json(job)
                if parts[3] == 'file':
                    if job['status'] != 'ready':
                        return self.send_json({'error': 'El archivo todavía no está listo.'}, 409)
                    path = Path(EXPORT_DIR.name) / (job['id'] + '.xlsx')
                    with path.open('rb') as file:
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                        self.send_header('Content-Disposition', 'attachment; filename="COLUN_CuadroResultado.xlsx"')
                        self.send_header('Cache-Control', 'no-store')
                        self.send_header('Content-Length', str(path.stat().st_size))
                        self.end_headers()
                        shutil.copyfileobj(file, self.wfile, length=1024 * 1024)
                    return
            self.send_json({'error': 'Recurso no encontrado.'}, 404)
        except (ValueError, OverflowError):
            self.send_json({'error': 'Número de página inválido.'}, 400)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as error:
            detail = error.args[0] if error.args and isinstance(error.args[0], dict) else {}
            print('Query failed:', type(error).__name__, detail.get('C', ''), flush=True)
            self.send_json({'error': 'No se pudo consultar PostgreSQL. Verificá la conexión de la pasarela.'}, 503)

    def do_POST(self):
        if not self.authorized():
            return self.send_json({'error': 'Acceso no autorizado.'}, 401)
        if self.path != '/api/exports':
            return self.send_json({'error': 'Recurso no encontrado.'}, 404)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length > 1024:
                return self.send_json({'error': 'Solicitud demasiado grande.'}, 413)
            self.rfile.read(length)
            return self.send_json(start_export(), 202)
        except (ValueError, OverflowError):
            self.send_json({'error': 'Solicitud inválida.'}, 400)


if __name__ == '__main__':
    if '--stdin-config' in sys.argv:
        print('Ready for gateway JSON on stdin (input is hidden).', flush=True)
        CONFIG.update(json.loads(getpass.getpass('')))
    else:
        CONFIG.update(password=getpass.getpass('Contraseña PostgreSQL: '),
                      token=getpass.getpass('Token de la pasarela: '))
    if not CONFIG.get('password') or len(CONFIG.get('token', '')) < 32:
        raise SystemExit('Falta la contraseña o un token de al menos 32 caracteres.')
    server = ThreadingHTTPServer(('127.0.0.1', 8765), Handler)
    print('COLUN gateway ready on http://127.0.0.1:8765 (read-only, bearer required).', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        POOL.shutdown(wait=True)
        EXPORT_DIR.cleanup()
