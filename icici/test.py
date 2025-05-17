import http.client
import json
from datetime import datetime
import hashlib
import sys, json

# App related key and token
argument = json.loads(sys.argv[1])
session_token = argument['sessionToken']
session_token = argument['body']

app_key = 't8W086&730M11UG47649g22Cv26q41J3'
secret_key = '95O8`0r061i03v2eWx137M739^9235`7'
# session_token = 'U0VTSEExMDA6NDMxODg='
body = {"exchange_code": "NSE"}
payload_for_checksum = json.dumps(body, separators=(',', ':'))
print(payload_for_checksum)
#request-headers generation
current_date = datetime.utcnow().isoformat()[:19] + '.000Z'

checksum = hashlib.sha256((current_date+payload_for_checksum+secret_key).encode("utf-8")).hexdigest()
headers = {
    "Content-Type": "application/json",
    'X-Checksum': "token "+checksum,
    'X-Timestamp': current_date,
    'X-AppKey': app_key,
    'X-SessionToken': session_token
}

print('body before dumps ', body)
payload = json.dumps(body)
print('body after  dumps ', body)
print(payload)
print(headers)

conn = http.client.HTTPSConnection("api.icicidirect.com")
conn.request("GET", "/breezeapi/api/v1/portfolioholdings", payload, headers)
res = conn.getresponse()
data = res.read()
print(data.decode("utf-8"))