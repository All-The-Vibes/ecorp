& (Join-Path $pg 'initdb.exe') -D (Join-Path $qa 'database') -U issue48 --auth=trust --encoding=UTF8 --locale=C
