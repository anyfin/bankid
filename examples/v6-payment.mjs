import { BankIdClientV6 } from "../lib/bankid.js";

const bankid = new BankIdClientV6({ production: false });

// Example payment request
const paymentRequest = {
  endUserIp: "127.0.0.1",
  userVisibleTransaction: {
    transactionType: "card",
    recipient: {
      name: "Payment Recipients Inc."
    },
    money: {
      amount: "100,00",
      currency: "EUR"
    },
    riskWarning: "largeAmount"
  },
  userVisibleData: "Payment confirmation",
  userVisibleDataFormat: "plaintext",
  returnUrl: "https://example.com/payment/complete",
  returnRisk: true,
  riskFlags: ["largeAmount", "newCustomer"],
  web: {
    deviceIdentifier: "device-123",
    referringDomain: "example.com",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15"
  }
};

bankid
  .payment(paymentRequest)
  .then(response => {
    console.log("Payment order created:", response.orderRef);
    console.log("QR Code available:", !!response.qr);
    
    // Collect the result
    return bankid.awaitPendingCollect(response.orderRef);
  })
  .then(result => {
    console.log("Payment completed:", result.completionData);
    if (result.completionData?.risk) {
      console.log("Risk level:", result.completionData.risk);
    }
  })
  .catch(error => {
    console.error("Payment failed:", error);
  });
