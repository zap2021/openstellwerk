import socket,struct,random,sys
M=0xffffffff
rol=lambda x,n:((x<<n)|(x>>(32-n)))&M
def init(key): return ((key^0x731b)&0xffff)|((((key^0xc57a)&0xffff))<<16)
def enc(buf,key):
    b=bytearray(buf); s=init(key)
    for i in range(0,len(b)&~3,4):
        d=struct.unpack_from('<I',b,i)[0]
        c=rol(d^s,19)^s; struct.pack_into('<I',b,i,c); s=c
    return bytes(b)
def dec(buf,key):
    b=bytearray(buf); s=init(key)
    for i in range(0,len(b)&~3,4):
        c=struct.unpack_from('<I',b,i)[0]
        d=rol(c^s,13)^s  # ror19 == rol13
        struct.pack_into('<I',b,i,d); s=c
    return bytes(b)
def frame(cmd,datalen,data=b'',write=False,seq=None):
    seq=random.randrange(0x10000) if seq is None else seq
    n=(len(data)+0x10) if write else 0x10
    f=bytearray(struct.pack('<HHHHII',n,cmd,0,seq,0,datalen)+data)
    body=enc(bytes(f[8:n]),seq)
    f[8:n]=body
    struct.pack_into('<H',f,0,n|0x8000)
    return bytes(f),seq
def parse(pkt):
    n=struct.unpack_from('<H',pkt,0)[0]; enc_=bool(n&0x8000); n&=0x7fff
    seq=struct.unpack_from('<H',pkt,6)[0]
    b=bytearray(pkt)
    if enc_: b[8:n]=dec(bytes(b[8:n]),seq)
    return dict(len=n,cmd=struct.unpack_from('<H',b,2)[0],result=struct.unpack_from('<H',b,4)[0],seq=seq,raw=bytes(b[:max(n,len(pkt))]))
def xfer(host,pkt,port=21106,timeout=3):
    s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(timeout); s.bind(('',0))
    s.sendto(pkt,(host,port))
    try: return s.recvfrom(2048)
    except socket.timeout: return None
    finally: s.close()
if __name__=='__main__':
    # self test of the cipher
    k=0x1234; p=bytes(range(16)); assert dec(enc(p,k),k)==p
    host=sys.argv[1]; cmd=int(sys.argv[2],16); dl=int(sys.argv[3],0)
    f,seq=frame(cmd,dl)
    print('send',f.hex())
    r=xfer(host,f)
    if not r: print('no reply')
    else:
        print('recv',r[0].hex()); print(parse(r[0]))
