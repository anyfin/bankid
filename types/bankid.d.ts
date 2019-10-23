interface BankIdSettings {
    production: boolean,
    refreshInterval: number,
    pfx?: string,
    passphrase?: string,
    ca?: string
}

interface BankIdRequirement {
    cardReader?: "class1" | "class2"
    certificatePolicies?: string[],
    issuerCn?: string[],
    autoStarkTokenRequired?: boolean
    allowFingerprint?: boolean
}

export default class BankId {

    constructor(options?: BankIdSettings);

    authenticate(endUserIp: string, personalNumber?: string, requirement?: BankIdRequirement): object

    sign(endUserIp: string, userVisibleData: string, personalNumber?: string, userNonVisibleData?: string, requirement?: BankIdRequirement): object

    collect(orderRef: string): object

    cancel(orderRef: string): object

    authenticateAndCollect(): object

    signAndCollect(): object
}


