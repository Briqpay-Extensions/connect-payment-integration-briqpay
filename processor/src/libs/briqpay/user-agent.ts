import packageJSON from '../../../package.json'

// package.json is the release source of truth, so the version Briqpay sees is the released one.
export const BRIQPAY_USER_AGENT = `${packageJSON.name}/${packageJSON.version} (node/${process.versions.node})`
