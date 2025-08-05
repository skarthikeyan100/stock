type OrderStatus = 'pending' | 'completed';

interface Order {
  id: number;
  status: OrderStatus;
  details: string;
}

class Queue {
  private items: Order[] = [];

  // Add an order to the queue
  enqueue(order: Order): void {
    this.items.push(order);
  }

  // Process orders one by one only if the previous is completed
  async processOrders(): Promise<void> {
    for (let i = 0; i < this.items.length; i++) {
      const currentOrder = this.items[i];

      if (currentOrder.status === 'completed') {
        console.log(`✅ Processing Order ${currentOrder.id}: ${currentOrder.details}`);
      } else {
        console.log(`⏸️ Skipping Order ${currentOrder.id} - Status: ${currentOrder.status}`);
        break; // Stop processing until this order is completed
      }
    }
  }

  // Mark an order completed by ID
  completeOrder(id: number): void {
    const order = this.items.find(o => o.id === id);
    if (order) order.status = 'completed';
  }

  // Get the queue state
  getQueue(): Order[] {
    return [...this.items];
  }
}
