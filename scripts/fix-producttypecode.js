// scripts/fix-producttypecode.js
//
// Patches producttypecode = 1 on all children of the "Remanufactured Printer Cartridges"
// family in PROD Dataverse. The cartridges page filters on producttypecode = 1; the 28
// child records currently have producttypecode = null, so the FetchXML returns 0 rows.
//
// Usage:
//   node scripts/fix-producttypecode.js              # dry-run, prints what would change
//   node scripts/fix-producttypecode.js --commit     # actually PATCHes prod
//
// Reads credentials from the project .env (same vars js/server.js uses):
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, DATAVERSE_URL
//
// Idempotent: re-running after a successful commit is a no-op.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const axios = require('axios');

const PARENT_PRODUCT_ID = '4b81c571-03f0-f011-8407-7ced8da584f0'; // prod "Remanufactured Printer Cartridges" family
const TARGET_PRODUCT_TYPE_CODE = 1; // 1 = Sales Product

const COMMIT = process.argv.includes('--commit');

async function getToken() {
    const tenant = (process.env.AZURE_TENANT_ID || '').trim();
    const clientId = (process.env.AZURE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.AZURE_CLIENT_SECRET || '').trim();
    const dataverseUrl = (process.env.DATAVERSE_URL || '').trim().replace(/\/+$/, '');

    if (!tenant || !clientId || !clientSecret || !dataverseUrl) {
        throw new Error('Missing AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / DATAVERSE_URL in .env');
    }

    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('scope', `${dataverseUrl}/.default`);
    params.append('client_secret', clientSecret);
    params.append('grant_type', 'client_credentials');

    const resp = await axios.post(
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        params,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return { token: resp.data.access_token, dataverseUrl };
}

async function listChildren(token, dataverseUrl) {
    const url = `${dataverseUrl}/api/data/v9.2/products`
        + `?$filter=_parentproductid_value eq ${PARENT_PRODUCT_ID}`
        + `&$select=productid,name,productnumber,producttypecode,statecode`
        + `&$count=true`;
    const resp = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'OData-Version': '4.0',
            'OData-MaxVersion': '4.0',
            Prefer: 'odata.include-annotations="*"'
        }
    });
    return resp.data.value || [];
}

async function patchProductTypeCode(token, dataverseUrl, productId) {
    const url = `${dataverseUrl}/api/data/v9.2/products(${productId})`;
    await axios.patch(
        url,
        { producttypecode: TARGET_PRODUCT_TYPE_CODE },
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'OData-Version': '4.0',
                'OData-MaxVersion': '4.0',
                'If-Match': '*'
            }
        }
    );
}

(async () => {
    console.log(`Mode: ${COMMIT ? 'COMMIT (live writes)' : 'DRY-RUN (no writes)'}`);
    console.log(`Parent product: ${PARENT_PRODUCT_ID}`);
    console.log(`Target producttypecode: ${TARGET_PRODUCT_TYPE_CODE}`);
    console.log('');

    const { token, dataverseUrl } = await getToken();
    console.log(`Authenticated against ${dataverseUrl}`);

    const children = await listChildren(token, dataverseUrl);
    console.log(`Found ${children.length} child product(s).`);
    console.log('');

    const needsUpdate = children.filter(p => p.producttypecode !== TARGET_PRODUCT_TYPE_CODE);
    const alreadyCorrect = children.length - needsUpdate.length;

    console.log(`Already correct: ${alreadyCorrect}`);
    console.log(`Needs update:    ${needsUpdate.length}`);
    console.log('');

    if (needsUpdate.length === 0) {
        console.log('Nothing to do. Exiting.');
        return;
    }

    console.log('Records that will be patched:');
    for (const p of needsUpdate) {
        console.log(`  ${p.productnumber.padEnd(28)}  ${p.name.padEnd(20)}  current=${p.producttypecode}  -> ${TARGET_PRODUCT_TYPE_CODE}`);
    }
    console.log('');

    if (!COMMIT) {
        console.log('Dry-run only. Re-run with --commit to apply.');
        return;
    }

    console.log('Applying patches...');
    let ok = 0;
    let fail = 0;
    for (const p of needsUpdate) {
        try {
            await patchProductTypeCode(token, dataverseUrl, p.productid);
            console.log(`  OK   ${p.productnumber}`);
            ok++;
        } catch (e) {
            const msg = e.response?.data?.error?.message || e.message;
            console.log(`  FAIL ${p.productnumber}  ${msg}`);
            fail++;
        }
    }
    console.log('');
    console.log(`Done. Succeeded: ${ok}.  Failed: ${fail}.`);

    console.log('');
    console.log('Verifying...');
    const after = await listChildren(token, dataverseUrl);
    const stillWrong = after.filter(p => p.producttypecode !== TARGET_PRODUCT_TYPE_CODE);
    console.log(`Children with producttypecode != ${TARGET_PRODUCT_TYPE_CODE}: ${stillWrong.length}`);
    if (stillWrong.length === 0) {
        console.log('All cartridges now have producttypecode = 1. Restart the Railway service (or wait 15 min) to flush /api/store cache.');
    }
})().catch(err => {
    console.error('FATAL:', err.response?.data || err.message);
    process.exit(1);
});
