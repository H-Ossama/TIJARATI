const { createApp } = require('./app');

const app = createApp();
const PORT = 3000;

app.listen(PORT, () => {
  console.log(`🚀 Tijarati Server running on http://localhost:${PORT}`);
});
