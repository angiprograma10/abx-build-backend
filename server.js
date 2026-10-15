const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const sessions = {};

app.post('/register', (req, res) => {
  const { code } = req.body;
  sessions[code] = { connected: false, pendingCode: null };
  res.json({ ok: true });
});

app.post('/connect', (req, res) => {
  const { code } = req.body;
  if (sessions[code]) {
    sessions[code].connected = true;
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Code not found' });
  }
});

app.post('/send', (req, res) => {
  const { code, script } = req.body;
  if (sessions[code]) {
    sessions[code].pendingCode = script;
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/poll/:code', (req, res) => {
  const code = req.params.code;
  if (sessions[code]) {
    const script = sessions[code].pendingCode;
    sessions[code].pendingCode = null;
    res.json({ script });
  } else {
    res.json({ script: null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ABX Build Backend running on', PORT));
