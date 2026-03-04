// src/middleware/roleMiddleware.js

export function checkSeller(req, res, next) {
  if (req.user.role !== 'seller') {
    return res.status(403).json({ error: 'Only sellers can do this.' });
  }
  next();
}

export function checkCustomer(req, res, next) {
  if (req.user.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can do this.' });
  }
  next();
}

