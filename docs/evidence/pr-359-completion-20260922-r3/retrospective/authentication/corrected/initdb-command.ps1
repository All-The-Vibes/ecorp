& (Join-Path $pg 'initdb.exe') -D (Join-Path $qa 'database') -U issue48 --auth=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$passwordPath
