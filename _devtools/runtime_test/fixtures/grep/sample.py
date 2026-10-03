def outer():
    def inner():
        TARGET = 1
        return TARGET
    return inner()
