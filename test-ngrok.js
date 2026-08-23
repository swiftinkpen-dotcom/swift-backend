async function testNgrok() {
  const url = "https://7fe9-2401-4900-cac7-4534-45d4-1b74-fe9-3826.ngrok-free.app/api/companies/initial-state?tenantId=demo-tenant-1";
  console.log("Testing ngrok fetch to:", url);
  try {
    const res = await fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true" }
    });
    console.log("Status:", res.status, res.statusText);
    const text = await res.text();
    console.log("Response length:", text.length);
    console.log("First 300 chars of response:", text.substring(0, 300));
    try {
      const json = JSON.parse(text);
      console.log("Parsed JSON successfully! Employees count:", json.employees?.length);
      console.log("Employees summary:", json.employees?.map(e => ({ empCode: e.empCode || e.code, name: e.name, pass: e.password })));
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr.message);
    }
  } catch (err) {
    console.error("Fetch error:", err.message);
  }
}

testNgrok();
