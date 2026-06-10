import requests, json, sys

BASE = "http://localhost:3001/api"

# Login
r = requests.post(f"{BASE}/auth/login", json={"email": "zhang@aerolink.com", "password": "password123"})
if r.status_code != 200:
    print(f"Login failed: {r.status_code} {r.text}")
    sys.exit(1)
token = r.json()["token"]
h = {"Authorization": f"Bearer {token}"}
results = []

def test(name, method, url, expected=200, data=None):
    try:
        r = getattr(requests, method)(f"{BASE}{url}", headers=h, json=data, timeout=10)
        ok = r.status_code == expected
        tag = "PASS" if ok else "FAIL"
        detail = ""
        if not ok:
            detail = f" (got {r.status_code})"
        elif r.headers.get("content-type","").startswith("application/json"):
            try:
                j = r.json()
                if "message" in j:
                    detail = f" -> {j['message']}"
            except: pass
        print(f"[{tag}] {name}: {r.status_code}{detail}")
        results.append(ok)
        return r
    except Exception as e:
        print(f"[FAIL] {name}: {e}")
        results.append(False)
        return None

# 1. DELETE inventory
print("=== DELETE Interfaces ===")
r = test("Create inventory", "post", "/inventory", 201, {
    "partNumber": "FIX-DEL-001", "description": "Delete Fix Test", "quantity": 3,
    "unitPrice": 99.99, "warehouse": "Test WH", "condition": "NEW"
})
if r and r.status_code == 201:
    test("DELETE inventory", "delete", f"/inventory/{r.json()['data']['id']}", 200)

# 2. DELETE customer
r = test("Create customer", "post", "/customers", 201, {
    "name": "Fix Delete Customer", "code": "FIX-DEL-C", "contactName": "Test",
    "email": "fixdel@test.com", "phone": "111"
})
if r and r.status_code == 201:
    test("DELETE customer", "delete", f"/customers/{r.json()['data']['id']}", 200)

# 3. DELETE supplier
r = test("Create supplier", "post", "/suppliers", 201, {
    "name": "Fix Delete Supplier", "code": "FIX-DEL-S", "contactName": "Test",
    "email": "fixdels@test.com", "phone": "222", "level": "B"
})
if r and r.status_code == 201:
    test("DELETE supplier", "delete", f"/suppliers/{r.json()['data']['id']}", 200)

# 4. RFQ create without requiredDate
print("\n=== RFQ requiredDate Optional ===")
test("Create RFQ no requiredDate", "post", "/rfqs", 201, {
    "customerName": "Fix Test Air", "contactInfo": "fix@test.com",
    "parts": [{"partNumber": "FIX-RFQ-001", "description": "Fix Test", "quantity": 2}]
})

# 5. Quotation create with valid rfqId
print("\n=== Quotation with rfqId ===")
rfqs = requests.get(f"{BASE}/rfqs", headers=h).json()
rfq_list = rfqs.get("data", [])
if rfq_list:
    test("Create quotation", "post", "/quotations", 201, {
        "rfqId": rfq_list[0]["id"],
        "parts": [{"partNumber": "FIX-Q-001", "description": "Fix", "quantity": 1, "unitPrice": 250}],
        "validUntil": "2026-12-31", "terms": "Net 30"
    })

# 6. Email Accounts
print("\n=== Email Accounts Route ===")
test("GET email-accounts (manager=403 expected)", "get", "/email-accounts", 403)

# Summary
print(f"\n{'='*40}")
passed = sum(results)
total = len(results)
print(f"Results: {passed}/{total} passed")
if passed == total:
    print("ALL FIXES VERIFIED!")
else:
    print(f"{total - passed} test(s) FAILED")
