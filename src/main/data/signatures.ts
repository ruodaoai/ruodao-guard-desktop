export interface SignatureRecord {
  name: string
  category: 'trojan' | 'malware' | 'riskware' | 'test'
  severity: 'high' | 'medium' | 'low'
  sha256: string
  description: string
}

export const DEMO_MARKER = 'RDP-GUARD-DEMO-SAMPLE'
export const DEMO_SAMPLE_NAME = 'Ruodao.Demo.Test'
export const EICAR_PREFIX = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

export const SIGNATURES: SignatureRecord[] = [
  {
    name: 'EICAR-Test-File',
    category: 'test',
    severity: 'medium',
    sha256: '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f',
    description: 'EICAR 标准防病毒测试文件，不包含任何恶意代码，用于验证查杀引擎是否正常工作'
  }
]
