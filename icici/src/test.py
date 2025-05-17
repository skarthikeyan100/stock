t1 = (1,2,3)
t2 = (3,2,11)
print(t1<t2)
print(t1==t2)
l = list(zip(t1,t2))
print(l)

def has_match(t1,t2):
    for x,y in zip(t1,t2):
        if x==y:
            print("hi")
            return True
        print("hello")
    return False

res = has_match(t1,t2)
print(res)

name = "abc"
def f():
    nonlocal name
    name = "xyz"
    def f1():
        
        print(name)
    f1()
f()