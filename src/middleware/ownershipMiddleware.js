// src/middleware/ownershipMiddleware.js
import { supabase } from '../supabaseClient.js';

async function checkOrderOwnership(req, res, next) {
  const { orderId } = req.body; // or req.query if your route uses query params
  const userId = req.user.id;

  const { data: order, error } = await supabase
    .from('orders')
    .select('id, seller_id, customer_id')
    .eq('id', orderId)
    .single();

  if (error || !order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (req.user.role === 'seller' && order.seller_id !== userId) {
    return res.status(403).json({ error: 'You do not own this order.' });
  }

  if (req.user.role === 'customer' && order.customer_id !== userId) {
    return res.status(403).json({ error: 'You do not own this order.' });
  }

  next();
}

export { checkOrderOwnership };
