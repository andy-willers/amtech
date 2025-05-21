const SftpClient = require('ssh2-sftp-client');
const csv = require('csv-parser');
const axios = require('axios');
const fs = require('fs');
const cron = require('node-cron');
require('dotenv').config();

const sftp = new SftpClient();

const getCSVFromSFTP = async () => {
  await sftp.connect({
    host: process.env.SFTP_HOST,
    port: process.env.SFTP_PORT,
    username: process.env.SFTP_USER,
    password: process.env.SFTP_PASSWORD,
  });

  const tempFile = 'inventory.csv';
  await sftp.fastGet(process.env.SFTP_FILE_PATH, tempFile);
  await sftp.end();

  return new Promise((resolve, reject) => {
    const data = [];
    fs.createReadStream(tempFile)
      .pipe(csv({ separator: '\t' }))
      .on('data', (row) => {
        data.push({
          sku: row.product_code,
          stock: parseInt(row.product_stocklevel),
          price: parseFloat(row.product_price),
        });
      })
      .on('end', () => resolve(data))
      .on('error', reject);
  });
};

const updateProduct = async (sku, stock, price) => {
  try {
    const { data } = await axios.get(`https://${process.env.SHOPIFY_STORE_NAME}/admin/api/2023-10/products.json?handle=${sku}`, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      },
    });

    const product = data.products.find(p => p.variants.find(v => v.sku === sku));
    if (!product) {
      console.log(`Product not found for SKU ${sku}`);
      return;
    }

    const variant = product.variants.find(v => v.sku === sku);

    // Update price
    await axios.put(`https://${process.env.SHOPIFY_STORE_NAME}/admin/api/2023-10/variants/${variant.id}.json`, {
      variant: { id: variant.id, price }
    }, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      },
    });

    // Update stock
    await axios.post(`https://${process.env.SHOPIFY_STORE_NAME}/admin/api/2023-10/inventory_levels/set.json`, {
      location_id: process.env.LOCATION_ID,
      inventory_item_id: variant.inventory_item_id,
      available: stock
    }, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      },
    });

    console.log(`Updated SKU ${sku}: Stock ${stock}, Price ${price}`);
  } catch (err) {
    console.error(`Failed to update SKU ${sku}:`, err.response?.data?.errors || err.message);
  }
};

const runSync = async () => {
  console.log('Running inventory sync...');
  const products = await getCSVFromSFTP();
  for (const item of products) {
    await updateProduct(item.sku, item.stock, item.price);
  }
};

cron.schedule('*/30 * * * *', runSync);
runSync();
