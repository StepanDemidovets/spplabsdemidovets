const jwt = require('jsonwebtoken');

function authMiddleware(secret) {
  return function (req, res, next) {
    const token = req.cookies && req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      req.user = jwt.verify(token, secret);
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

module.exports = { authMiddleware };
