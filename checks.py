"""Integration checks for pagination, upstream protection and literal Excel export."""
import getpass
import json
import tempfile
from pathlib import Path
import urllib.error
import urllib.request
import gateway
import openpyxl


def request(path, token=None, base='http://127.0.0.1:8765'):
    headers={'Authorization':'Bearer '+token} if token else {}
    with urllib.request.urlopen(urllib.request.Request(base+path,headers=headers),timeout=90) as r:
        return json.load(r)


if __name__ == '__main__':
    print('Ready for test JSON on stdin (input is hidden).',flush=True)
    config=json.loads(getpass.getpass(''))
    gateway.CONFIG.update(config)
    try:
        request('/api/metadata')
        raise AssertionError('Unauthenticated request was accepted')
    except urllib.error.HTTPError as e:
        assert e.code==401
    meta=request('/api/metadata',config['token'])
    assert len(meta['columns'])==68
    first=request('/api/rows?page=1',config['token'])
    second=request('/api/rows?page=2',config['token'])
    last=request('/api/rows?page='+str(meta['pages']),config['token'])
    assert len(first['rows'])==50 and len(second['rows'])==50
    assert all(len(row)==68 for row in first['rows'])
    assert len(last['rows'])==meta['total']-(meta['pages']-1)*50
    assert first['rows']!=second['rows']
    print(json.dumps({'pages':meta['pages'],'total':meta['total'],'columns':len(meta['columns']),
                      'firstPage':len(first['rows']),'secondPage':len(second['rows']),
                      'lastPage':len(last['rows']),'unauthorizedBlocked':True}),flush=True)
    # Export real data through a server cursor, with an intentionally small sheet limit.
    with tempfile.TemporaryDirectory() as tmp:
        output=Path(tmp)/'check.xlsx'
        with gateway.database() as cursor:
            cursor.execute('DECLARE export_rows NO SCROLL CURSOR FOR SELECT * FROM '+gateway.TABLE+' ORDER BY ctid LIMIT 51')
            count,sheets=gateway.write_workbook(cursor,output,meta['columns'],sheet_limit=25)
            cursor.execute('CLOSE export_rows')
        book=openpyxl.load_workbook(output,read_only=True,data_only=False)
        sizes=[sum(1 for _ in sheet.iter_rows())-1 for sheet in book]
        assert sizes==[25,25,1] and count==51 and sheets==3
        exported=list(book.worksheets[0].iter_rows(values_only=True))[1]
        assert list(exported)==first['rows'][0]
        book.close()
        # Exercise the actual binary COPY path and compare every value to the source.
        snapshot=Path(tmp)/'snapshot.pgcopy'
        with gateway.database() as cursor:
            cursor.execute('SELECT * FROM '+gateway.TABLE+' ORDER BY ctid LIMIT 51')
            expected=[list(row) for row in cursor.fetchall()]
            with snapshot.open('wb') as stream:
                cursor.execute('COPY (SELECT * FROM '+gateway.TABLE+' ORDER BY ctid LIMIT 51) TO STDOUT (FORMAT BINARY)',stream=stream)
        with snapshot.open('rb') as stream:
            assert gateway.BinaryCursor(stream,68).fetchall()==expected
        with snapshot.open('rb') as stream:
            count,sheets=gateway.write_workbook(gateway.BinaryCursor(stream,68),output,meta['columns'])
        book=openpyxl.load_workbook(output,read_only=True,data_only=False)
        exported=list(book.active.iter_rows(values_only=True))[1:]
        assert [list(row) for row in exported]==expected
        assert count==51
        book.close()
        class FakeCursor:
            def __init__(self):self.done=False
            def execute(self,*args):pass
            def fetchall(self):
                if self.done:return []
                self.done=True;return [('=1+1','001234',None,'áéíóú <script>')]
        gateway.write_workbook(FakeCursor(),output,['formula','id','null','unicode'])
        book=openpyxl.load_workbook(output,read_only=True,data_only=False)
        values=list(book.active.iter_rows())[1]
        assert values[0].value=='=1+1' and values[0].data_type=='s'
        assert values[1].value=='001234' and values[2].value is None
        assert values[3].value=='áéíóú <script>'
        book.close()
        print(json.dumps({'excelRows':count,'excelColumns':68,'splitSheets':sizes,'binarySnapshotVerified':True,
                          'valuesPreserved':True,'formulasAsText':True}),flush=True)
    remote=request('/api/metadata',config['token'],config['bridgeUrl'])
    assert remote['total']==meta['total']
    print('HTTPS gateway verified.',flush=True)
