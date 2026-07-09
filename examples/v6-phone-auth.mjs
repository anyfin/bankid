import { BankIdClientV6 } from "../lib/bankid.js";

const bankid = new BankIdClientV6({ production: false });

// Example phone authentication request
const phoneAuthRequest = {
  callInitiator: "user", // or "RP" if you called the user
  userVisibleData: "Phone authentication",
  userVisibleDataFormat: "plaintext",
  personalNumber: "200001012384" // optional
};

bankid
  .phoneAuth(phoneAuthRequest)
  .then(response => {
    console.log("Phone auth order created:", response.orderRef);
    
    // Collect the result
    return bankid.awaitPendingCollect(response.orderRef);
  })
  .then(result => {
    console.log("Phone auth completed:", result.completionData);
  })
  .catch(error => {
    console.error("Phone auth failed:", error);
  });
